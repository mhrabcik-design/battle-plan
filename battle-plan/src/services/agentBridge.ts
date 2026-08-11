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
import { createWorkLogSyncId } from '../utils/workLogSyncIdentity.ts';
import { drainGoogleExternalEffects } from './externalEffectOutbox.ts';
import { newTaskMutationContext, taskMutations } from './taskMutations.ts';

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

class AgentBridge {
  private fileId: string | null = null;
  private processedIds: Set<string> = new Set();
  private isInitialized = false;
  private readonly drive = new DriveJsonStore();

  async init(options: { createFolder?: boolean } = {}): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = await this.drive.init({ createFolder: options.createFolder ?? true });
    // Hydrate the processedIds fast-path cache from the durable Dexie mirror so
    // a reload survives a prior session that already applied some writes.
    // (The inbox file's applied_at is the primary filter; this cache avoids
    // an extra db.agentInbox read per id in fetchPendingWrites.)
    const applied = await db.agentInbox.where('applied_at').above(0).primaryKeys();
    for (const id of applied) this.processedIds.add(String(id));
  }

  async fetchPendingWrites(): Promise<AgentWrite[]> {
    if (!this.isInitialized) return [];

    try {
      const loaded = await this.drive.readJsonFile<PendingWritesFile>(PENDING_FILE);
      if (!loaded) return [];
      this.fileId = loaded.fileId;
      const writes: AgentWrite[] = (loaded.data.writes ?? []).filter(
        (w: AgentWrite) => !w.applied_at && !this.processedIds.has(w.id)
      );
      return writes;
    } catch (e) {
      console.error('AgentBridge: fetchPendingWrites failed', e);
      return [];
    }
  }

  async applyWrite(write: AgentWrite): Promise<ApplyWriteResult> {
    try {
      if (
        write.action === 'create_task' ||
        write.action === 'update_task' ||
        write.action === 'delete_task' ||
        write.action === 'complete_task'
      ) {
        return await this.applyTaskAction(write);
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
    } catch (e) {
      console.error('AgentBridge: applyWrite failed', e);
      return retryableWrite(e instanceof Error ? e.message : String(e));
    }
  }

  private async applyTaskAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = (write.task_data ?? {}) as Partial<Task> & { id?: number };
    if (write.action === 'create_task') {
      const norm = normalizeEntity(data, 'create', undefined);
      const mutation = await taskMutations.createTask({
        task: {
          ...norm.value,
          title: norm.value.title ?? 'Nový záznam',
          type: norm.value.type ?? 'thought',
          urgency: norm.value.urgency,
          status: norm.value.status,
          source: 'agent',
          agent_write_id: write.id,
        },
        context: newTaskMutationContext('hermes'),
        effects: norm.value.type === 'meeting' ? [{ kind: 'calendar', operation: 'upsert' }] : [],
      });
      if (mutation.status !== 'applied') return retryableWrite(`task mutation ${mutation.status}`);
      if (mutation.effectIds.length) await drainGoogleExternalEffects(mutation.effectIds);
      return appliedWrite({ newId: mutation.task.id, last_error: norm.last_error });
    }

    if (write.action === 'update_task') {
      if (!data.id) return terminalWrite('task_data.id missing');
      const existing = await db.tasks.get(data.id);
      if (!existing) return terminalWrite('task not found');
      const norm = normalizeEntity(data, 'update', existing);
      const mutation = await taskMutations.updateTask({
        localId: data.id,
        changes: {
          ...norm.value,
          source: existing.source ?? 'agent',
          agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
        },
        context: newTaskMutationContext('hermes'),
      });
      if (mutation.status !== 'applied') return terminalWrite(`task mutation ${mutation.status}`);
      return appliedWrite({ last_error: norm.last_error });
    }

    if (write.action === 'complete_task') {
      if (!data.id) return terminalWrite('task_data.id missing');
      const existing = await db.tasks.get(data.id);
      if (!existing) return terminalWrite('task not found');
      const norm = normalizeEntity(data, 'complete', existing);
      const mutation = await taskMutations.completeTask({
        localId: data.id,
        context: newTaskMutationContext('hermes'),
        effects: existing.googleId ? [{ kind: 'google_tasks', operation: 'complete' }] : [],
        changes: {
          ...norm.value,
          source: existing.source ?? 'agent',
          agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
        },
      });
      if (mutation.status !== 'applied') return terminalWrite(`task mutation ${mutation.status}`);
      if (mutation.effectIds.length) await drainGoogleExternalEffects(mutation.effectIds);
      return appliedWrite({ last_error: norm.last_error });
    }

    // delete_task
    if (!data.id) return terminalWrite('task_data.id missing');
    const existing = await db.tasks.get(data.id);
    if (!existing) return terminalWrite('task not found');
    const mutation = await taskMutations.archiveTask({
      localId: data.id,
      context: newTaskMutationContext('hermes'),
      effects: existing.googleEventId ? [{ kind: 'calendar', operation: 'delete' }] : [],
      changes: {
        source: existing.source ?? 'agent',
        agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
      },
    });
    if (mutation.status !== 'applied') return terminalWrite(`task mutation ${mutation.status}`);
    if (mutation.effectIds.length) await drainGoogleExternalEffects(mutation.effectIds);
    return appliedWrite();
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
      let saved: WorkLog;
      try {
        saved = await addWorkLogWithActiveProject(draft);
      } catch (error) {
        if (error instanceof ProjectUnavailableError) {
          return terminalWrite(error.message);
        }
        throw error;
      }
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

      try {
        await updateWorkLogWithProjectSelection({
          id: data.id,
          selectedProject,
          changes,
        });
      } catch (error) {
        if (error instanceof ProjectUnavailableError || (error instanceof Error && error.message === 'worklog-not-found')) {
          return terminalWrite(error.message);
        }
        throw error;
      }
      return appliedWrite();
    }

    // delete_worklog: hard delete (worklogs are not soft-deleted in this app).
    if (!data.id) return terminalWrite('worklog id missing');
    await db.workLogs.delete(data.id);
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

      // Přidej do processedIds pro případ, že by se soubor stáhl znovu
      for (const id of writeIds) this.processedIds.add(id);
    } catch (e) {
      console.error('AgentBridge: markApplied failed', e);
    }
  }

  // Mirror the inbox into db.agentInbox so the diagnostics surface can read
  // pending writes via useLiveQuery. U5. Idempotent on re-read.
  async mirrorInbox(writes: AgentWrite[]): Promise<void> {
    const now = Date.now();
    for (const w of writes) {
      const existing = await db.agentInbox.get(w.id);
      const row: AgentInboxRow = {
        id: w.id,
        action: w.action,
        entity_type: this.inferEntityType(w.action),
        entity_id: existing?.entity_id,
        payload: w,
        received_at: existing?.received_at ?? now,
        applied_at: w.applied_at,
        last_error: existing?.last_error,
      };
      await db.agentInbox.put(row);
    }
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
    const row = await db.agentInbox.get(id);
    if (!row) return;
    await db.agentInbox.put({
      ...row,
      applied_at: applied ? Date.now() : row.applied_at,
      last_error: lastError,
    });
  }

  async clearAppliedInbox(): Promise<void> {
    await db.agentInbox.where('applied_at').above(0).delete();
  }

  get initialized(): boolean { return this.isInitialized; }
}

export const agentBridge = new AgentBridge();
