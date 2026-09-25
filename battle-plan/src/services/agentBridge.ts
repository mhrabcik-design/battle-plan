import { googleService } from './googleService.ts';
import { normalizeEntity } from './semanticEngine.ts';
import type { AgentInboxRow, Project, Setting, Task, WorkLog } from '../db.ts';
import { db } from '../db.ts';
import { DriveJsonStore } from './driveJsonStore.ts';
import {
  archiveProject,
  createProject,
  updateProject,
  type ProjectCatalogResult,
} from './projectCatalog.ts';
import {
  addWorkLogWithActiveProject,
  ProjectUnavailableError,
  type NewWorkLogDraft,
  type WorkLogEditableChanges,
  updateWorkLogWithProjectSelection,
} from './workLogPersistence.ts';
import { deleteWorkLog } from './workLogDeletion.ts';
import { createWorkLogSyncId } from '../utils/workLogSyncIdentity.ts';
import { hasUsableAuth } from '../types.ts';
import { calendarEffectsForLocalTask, newTaskMutationContext, taskMutations, taskMutationTables, type TaskDraft, type TaskEffectRequest } from './taskMutations.ts';
import { drainGoogleExternalEffects } from './externalEffectOutbox.ts';

export type AgentWriteAction =
  | 'create_task'
  | 'update_task'
  | 'delete_task'
  | 'complete_task'
  | 'create_worklog'
  | 'update_worklog'
  | 'delete_worklog'
  | 'create_project'
  | 'update_project'
  | 'delete_project'
  | 'create_settings'
  | 'update_settings'
  | 'delete_settings';

export type AgentWriteTaskData = Partial<Task> & { id?: number };
export type AgentWriteWorklogData = Partial<Omit<WorkLog, 'id' | 'source' | 'agent_write_id' | 'updatedAt' | 'createdAt'>> & { id?: number };
export type AgentWriteProjectData = Partial<Omit<
  Project,
  'id' | 'aliases' | 'source' | 'agent_write_id' | 'updatedAt' | 'createdAt'
>> & { id?: number };
export type AgentWriteSettingsData = { id: string; value?: string };

export interface AgentWrite {
  id: string;
  action: AgentWriteAction;
  task_data?: AgentWriteTaskData;
  worklog_data?: AgentWriteWorklogData;
  project_data?: AgentWriteProjectData;
  settings_data?: AgentWriteSettingsData;
  created_at: number;
  applied_at?: number;
}

const PENDING_FILE = 'agent-pending-writes.json';

interface PendingWritesFile {
  writes?: AgentWrite[];
}

export interface ApplyWriteResult {
  success: boolean;
  disposition: 'applied' | 'terminal' | 'retryable';
  newId?: number;
  last_error?: string;
  outcome?: ProjectCatalogResult['outcome'];
}

type ApplyWriteDetails = Partial<Pick<ApplyWriteResult, 'newId' | 'last_error' | 'outcome'>>;

function appliedWrite(details: ApplyWriteDetails = {}): ApplyWriteResult {
  return { success: true, disposition: 'applied', ...details };
}

function terminalWrite(last_error: string, details: ApplyWriteDetails = {}): ApplyWriteResult {
  return { success: false, disposition: 'terminal', last_error, ...details };
}

function retryableWrite(last_error: string): ApplyWriteResult {
  return { success: false, disposition: 'retryable', last_error };
}

export function shouldAcknowledgeApplyWrite(result: ApplyWriteResult): boolean {
  return result.disposition !== 'retryable';
}

function projectResultToApplyWrite(result: ProjectCatalogResult): ApplyWriteResult {
  switch (result.outcome) {
    case 'created':
    case 'restored':
    case 'updated':
    case 'archived':
      return appliedWrite({ newId: result.project.id, outcome: result.outcome });
    case 'duplicate':
      return terminalWrite('project already exists', { outcome: result.outcome });
    case 'archived-match':
      return terminalWrite('project archived', { outcome: result.outcome });
    case 'conflict':
      return terminalWrite('project name conflict', { outcome: result.outcome });
    case 'validation':
      return terminalWrite(result.message, { outcome: result.outcome });
  }
}

interface LegacyReceipt extends AgentInboxRow {
  execution_result?: ApplyWriteResult;
  diagnosticsHidden?: boolean;
}

function commandIdentity(write: AgentWrite): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
    return value;
  };
  const payload = { ...write };
  delete payload.applied_at;
  return JSON.stringify(canonical(payload));
}

function replayResult(existing: LegacyReceipt | undefined, write: AgentWrite): ApplyWriteResult | undefined {
  if (!existing) return undefined;
  if (commandIdentity(existing.payload as AgentWrite) !== commandIdentity(write)) {
    return terminalWrite('command id reused with different payload');
  }
  if (existing.execution_result) return existing.execution_result;
  if (existing.applied_at) return appliedWrite({ newId: existing.entity_id, last_error: existing.last_error });
  return undefined;
}

class AgentBridge {
  private fileId: string | null = null;
  private isInitialized = false;
  private readonly drive = new DriveJsonStore();

  async init(options: { createFolder?: boolean } = {}): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = await this.drive.init({ createFolder: options.createFolder ?? true });
  }

  async fetchPendingWrites(): Promise<AgentWrite[]> {
    if (!this.isInitialized) return [];

    try {
      const loaded = await this.drive.readJsonFile<PendingWritesFile>(PENDING_FILE);
      if (!loaded) return [];
      this.fileId = loaded.fileId;
      const writes: AgentWrite[] = (loaded.data.writes ?? []).filter(
        (w: AgentWrite) => !w.applied_at
      );
      return writes;
    } catch (e) {
      console.error('AgentBridge: fetchPendingWrites failed', e);
      return [];
    }
  }

  async applyWrite(input: AgentWrite): Promise<ApplyWriteResult> {
    // Snapshot before waiting for another tab. Network delivery follows commit.
    const write = structuredClone(input);
    try {
      const effects: string[] = [];
      const result = await db.transaction('rw', [
        ...taskMutationTables(db), db.agentInbox, db.projects, db.workLogs,
        db.settings, db.workLogDeletionTombstones,
      ], async () => {
        const existing = await db.agentInbox.get(write.id) as LegacyReceipt | undefined;
        const replay = replayResult(existing, write);
        if (replay) return replay;
        const outcome = await this.executeWrite(write, effects);
        const row: LegacyReceipt = {
          id: write.id, action: write.action, entity_type: this.inferEntityType(write.action),
          payload: write, received_at: existing?.received_at ?? Date.now(),
          entity_id: outcome.newId, last_error: outcome.last_error,
          ...(shouldAcknowledgeApplyWrite(outcome)
            ? { applied_at: Date.now(), execution_result: outcome } : {}),
        };
        await db.agentInbox.put(row);
        return outcome;
      });
      await this.deliverTaskEffects(effects);
      return result;
    } catch (e) {
      // A nested Dexie validation failure aborts its parent transaction. Record
      // the terminal result only after rollback, preserving any winning receipt.
      if (e instanceof ProjectUnavailableError || (e instanceof Error && e.message === 'worklog-not-found')) {
        try {
          return await db.transaction('rw', db.agentInbox, async () => {
            const existing = await db.agentInbox.get(write.id) as LegacyReceipt | undefined;
            const replay = replayResult(existing, write);
            if (replay) return replay;
            const outcome = terminalWrite(e.message);
            const row: LegacyReceipt = {
              id: write.id, action: write.action, entity_type: this.inferEntityType(write.action),
              payload: write, received_at: existing?.received_at ?? Date.now(),
              applied_at: Date.now(), last_error: outcome.last_error, execution_result: outcome,
            };
            await db.agentInbox.put(row);
            return outcome;
          });
        } catch (receiptError) {
          return retryableWrite(receiptError instanceof Error ? receiptError.message : String(receiptError));
        }
      }
      console.error('AgentBridge: applyWrite failed', e);
      return retryableWrite(e instanceof Error ? e.message : String(e));
    }
  }

  private async executeWrite(write: AgentWrite, effects: string[]): Promise<ApplyWriteResult> {
    if (
      write.action === 'create_task' ||
      write.action === 'update_task' ||
      write.action === 'delete_task' ||
      write.action === 'complete_task'
    ) {
      return await this.applyTaskAction(write, effects);
    }
    if (write.action === 'create_worklog' || write.action === 'update_worklog' || write.action === 'delete_worklog') {
      return await this.applyWorklogAction(write);
    }
    if (write.action === 'create_project' || write.action === 'update_project' || write.action === 'delete_project') {
      return await this.applyProjectAction(write);
    }
    if (write.action === 'create_settings' || write.action === 'update_settings' || write.action === 'delete_settings') {
      return await this.applySettingsAction(write);
    }
    return terminalWrite(`unsupported action: ${write.action}`);
  }

  private async applyTaskAction(
    write: AgentWrite,
    effectsToDeliver: string[],
  ): Promise<ApplyWriteResult> {
    const data = (write.task_data ?? {}) as Partial<Task> & { id?: number };
    const context = newTaskMutationContext('hermes', undefined, googleService.getAccountId() ?? undefined);
    if (write.action === 'create_task') {
      const norm = normalizeEntity(data, 'create', undefined);
      const task = { ...norm.value, source: 'agent', agent_write_id: write.id } as TaskDraft;
      const result = await taskMutations.createTask({
        task, context,
        effects: calendarEffectsForLocalTask(task, 'upsert', hasUsableAuth(googleService.getAuthStatus()) && Boolean(context.googleAccountId)),
      });
      if (result.status !== 'applied') return terminalWrite(`task mutation ${result.status}`);
      effectsToDeliver.push(...result.effectIds);
      return appliedWrite({ newId: result.task.id, last_error: norm.last_error });
    }

    if (!data.id) return terminalWrite('task_data.id missing');
    const mutation = await db.transaction('rw', taskMutationTables(db), async () => {
      const existing = await db.tasks.get(data.id!);
      if (!existing || existing.isDeleted || (data.publicId && existing.publicId !== data.publicId)) return null;
      const action = write.action === 'delete_task' ? 'delete' : write.action === 'complete_task' ? 'complete' : 'update';
      const norm = normalizeEntity(data, action, existing);
      const changes = {
        ...(action === 'delete' ? {} : norm.value),
        source: existing.source ?? 'agent',
        agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
      };
      const effects: TaskEffectRequest[] = calendarEffectsForLocalTask(existing, action === 'delete' ? 'delete' : 'upsert');
      if (action === 'complete' && existing.googleId) effects.push({ kind: 'google_tasks', operation: 'complete' });
      const input = {
        localId: existing.id, publicId: existing.publicId, changes, context, effects,
        expectedRevision: data.protocolRevision?.revision_id,
      };
      const result = action === 'delete' ? await taskMutations.archiveTask(input)
        : action === 'complete' ? await taskMutations.completeTask(input) : await taskMutations.updateTask(input);
      return { result, last_error: norm.last_error };
    });
    if (!mutation) return terminalWrite('task not found');
    if (mutation.result.status !== 'applied') return terminalWrite(`task mutation ${mutation.result.status}`);
    effectsToDeliver.push(...mutation.result.effectIds);
    return appliedWrite({ last_error: mutation.last_error });
  }

  private async deliverTaskEffects(effectIds: readonly string[]): Promise<void> {
    if (!effectIds.length) return;
    try {
      await drainGoogleExternalEffects(effectIds);
    } catch (error) {
      // A locally applied legacy write must be acknowledged even when Google
      // delivery waits, otherwise polling would replay the domain mutation.
      console.error('AgentBridge: Google synchronization remains queued', error);
    }
  }

  private async applyWorklogAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = (write.worklog_data ?? {}) as Partial<WorkLog> & { id?: number };

    if (write.action === 'create_worklog') {
      if (!data.projectId) return terminalWrite('projectId required');
      if (!data.date) return terminalWrite('date required');
      if (typeof data.hours !== 'number' || data.hours <= 0) return terminalWrite('hours must be > 0');
      const now = Date.now();
      const draft: NewWorkLogDraft = {
        syncId: data.syncId ?? createWorkLogSyncId(),
        date: data.date,
        projectId: data.projectId,
        projectName: data.projectName,
        people: data.people ?? '',
        hours: data.hours,
        hoursPerPerson: data.hoursPerPerson,
        peopleCount: data.peopleCount,
        calculationNote: data.calculationNote,
        assumptions: data.assumptions,
        extractionBatchId: data.extractionBatchId,
        description: data.description,
        source: 'agent',
        agent_write_id: write.id,
        updatedAt: now,
        createdAt: now,
      };
      const saved = await addWorkLogWithActiveProject(draft);
      return appliedWrite({ newId: saved.id });
    }

    if (write.action === 'update_worklog') {
      if (!data.id) return terminalWrite('worklog id missing');
      const hasProjectId = data.projectId !== undefined;
      const hasProjectName = data.projectName !== undefined;
      if (hasProjectId !== hasProjectName) {
        return terminalWrite('projectId and projectName required together');
      }
      if (hasProjectId && (
        typeof data.projectId !== 'number'
        || !Number.isSafeInteger(data.projectId)
        || data.projectId <= 0
        || typeof data.projectName !== 'string'
        || !data.projectName.trim()
      )) {
        return terminalWrite('valid projectId and projectName required together');
      }

      const changes: WorkLogEditableChanges = {
        ...(data.date === undefined ? {} : { date: data.date }),
        ...(data.people === undefined ? {} : { people: data.people }),
        ...(data.hours === undefined ? {} : { hours: data.hours }),
        ...(data.hoursPerPerson === undefined ? {} : { hoursPerPerson: data.hoursPerPerson }),
        ...(data.peopleCount === undefined ? {} : { peopleCount: data.peopleCount }),
        ...(data.calculationNote === undefined ? {} : { calculationNote: data.calculationNote }),
        ...(data.assumptions === undefined ? {} : { assumptions: data.assumptions }),
        ...(data.extractionBatchId === undefined ? {} : { extractionBatchId: data.extractionBatchId }),
        ...(data.description === undefined ? {} : { description: data.description }),
        updatedAt: Date.now(),
      };
      const selectedProject = hasProjectId
        ? { id: data.projectId!, name: data.projectName! }
        : null;

      await updateWorkLogWithProjectSelection({
        id: data.id,
        selectedProject,
        changes,
      });
      return appliedWrite();
    }

    // Keep the portable deletion journal atomic with the command receipt.
    if (!data.id) return terminalWrite('worklog id missing');
    await deleteWorkLog(data.id);
    return appliedWrite();
  }

  private async applyProjectAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = (write.project_data ?? {}) as Partial<Project> & { id?: number };
    if (Object.prototype.hasOwnProperty.call(data, 'aliases')) {
      return terminalWrite('project aliases are not agent-writable');
    }

    if (write.action === 'create_project') {
      const result = await createProject({
        name: data.name ?? '',
        color: data.color,
        source: 'agent',
        agentWriteId: write.id,
        // A create_project inbox action is already an explicit request to make
        // a canonical project active. An absorbed alias remains a protected
        // identity and requires the ordinary explicit restore flow.
        confirmRestore: 'canonical-only',
      });
      return projectResultToApplyWrite(result);
    }

    if (write.action === 'update_project') {
      const result = await updateProject({
        id: data.id ?? 0,
        name: data.name,
        color: data.color,
      });
      return projectResultToApplyWrite(result);
    }

    const result = await archiveProject({ id: data.id ?? 0 });
    return projectResultToApplyWrite(result);
  }

  // Settings keys the agent is allowed to delete. gemini_model is intentionally
  // non-deletable so the model picker does not fall back to undefined.
  private static readonly DELETABLE_SETTINGS: Record<string, true> = { gemini_api_key: true };

  private async applySettingsAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = write.settings_data;
    if (!data || !data.id) return terminalWrite('settings id required');

    if (write.action === 'delete_settings') {
      if (!AgentBridge.DELETABLE_SETTINGS[data.id]) {
        return terminalWrite('key-not-deletable');
      }
      await db.settings.delete(data.id);
      return appliedWrite();
    }

    // create_settings / update_settings: the put() is the same operation in
    // Dexie; the action name disambiguates intent.
    if (data.value === '' && data.id === 'gemini_api_key') {
      return terminalWrite('gemini_api_key cannot be empty');
    }
    const existing = await db.settings.get(data.id);
    const next: Setting = {
      id: data.id,
      value: data.value ?? '',
      source: 'agent',
      agent_write_id: write.id,
    };
    if (existing) {
      // Preserve any pre-existing source/agent_write_id when the agent
      // re-asserts; otherwise stamp them.
      next.source = existing.source ?? 'agent';
      next.agent_write_id = existing.agent_write_id ?? write.id;
    }
    await db.settings.put(next);
    return appliedWrite();
  }

  async markApplied(writeIds: string[]): Promise<void> {
    if (!this.fileId || writeIds.length === 0) return;

    try {
      const loaded = await this.drive.readJsonFile<PendingWritesFile>(PENDING_FILE);
      if (!loaded) return;
      this.fileId = loaded.fileId;
      const data = loaded.data;

      // Označ jako aplikované
      const now = Date.now();
      const writes: AgentWrite[] = (data.writes ?? []).map((w: AgentWrite) =>
        writeIds.includes(w.id) ? { ...w, applied_at: now } : w
      );

      const updatedData = { ...data, writes };
      await this.drive.writeJsonFile(PENDING_FILE, updatedData, this.fileId);

    } catch (e) {
      console.error('AgentBridge: markApplied failed', e);
    }
  }

  // Mirror the inbox into db.agentInbox so the diagnostics surface can read
  // pending writes via useLiveQuery. U5. Idempotent on re-read.
  async mirrorInbox(writes: AgentWrite[]): Promise<void> {
    await db.transaction('rw', db.agentInbox, async () => {
      for (const w of writes) {
        // Preserve the original payload and any atomically committed receipt.
        if (await db.agentInbox.get(w.id)) continue;
        await db.agentInbox.put({
          id: w.id, action: w.action, entity_type: this.inferEntityType(w.action),
          payload: w, received_at: Date.now(), applied_at: w.applied_at,
        });
      }
    });
  }

  // Record forces TypeScript to flag a missing entry when a new action is
  // added to the union (compile-time coverage instead of runtime fallback).
  private static readonly ENTITY_BY_ACTION: Record<AgentWriteAction, 'task' | 'worklog' | 'project' | 'settings'> = {
    create_task: 'task', update_task: 'task', delete_task: 'task', complete_task: 'task',
    create_worklog: 'worklog', update_worklog: 'worklog', delete_worklog: 'worklog',
    create_project: 'project', update_project: 'project', delete_project: 'project',
    create_settings: 'settings', update_settings: 'settings', delete_settings: 'settings',
  };

  private inferEntityType(action: AgentWriteAction): 'task' | 'worklog' | 'project' | 'settings' {
    return AgentBridge.ENTITY_BY_ACTION[action];
  }

  // Mark a single inbox row as applied (or failed). U5. Called by useAgentBridgePolling
  // after applyWrite runs.
  async recordInboxResult(id: string, applied: boolean, lastError?: string): Promise<void> {
    await db.transaction('rw', db.agentInbox, async () => {
      const row = await db.agentInbox.get(id);
      if (!row || row.applied_at) return;
      await db.agentInbox.put({
        ...row,
        applied_at: applied ? Date.now() : row.applied_at,
        last_error: lastError,
      });
    });
  }

  async listInbox(): Promise<AgentInboxRow[]> {
    return db.agentInbox.filter((row: LegacyReceipt) => !row.diagnosticsHidden).toArray();
  }

  async clearAppliedInbox(): Promise<void> {
    await db.agentInbox.where('applied_at').above(0).modify((row: LegacyReceipt) => {
      // Clearing diagnostics must never clear the execution receipt.
      row.diagnosticsHidden = true;
    });
  }

  get initialized(): boolean { return this.isInitialized; }
}

export const agentBridge = new AgentBridge();
