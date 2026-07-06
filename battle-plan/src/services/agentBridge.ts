import { googleService } from './googleService.ts';
import { normalizeEntity } from './semanticEngine.ts';
import type { AgentInboxRow, Project, Setting, Task, WorkLog } from '../db.ts';
import { db } from '../db.ts';
import { DriveJsonStore } from './driveJsonStore.ts';

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
export type AgentWriteProjectData = Partial<Omit<Project, 'id' | 'source' | 'agent_write_id' | 'updatedAt' | 'createdAt'>> & { id?: number };
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
  newId?: number;
  last_error?: string;
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
      return { success: false, last_error: `unsupported action: ${write.action}` };
    } catch (e) {
      console.error('AgentBridge: applyWrite failed', e);
      return { success: false, last_error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async applyTaskAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = (write.task_data ?? {}) as Partial<Task> & { id?: number };
    if (write.action === 'create_task') {
      const norm = normalizeEntity(data, 'create', undefined);
      const newId = await db.tasks.add({
        ...norm.value,
        source: 'agent',
        agent_write_id: write.id,
        updatedAt: Date.now(),
        createdAt: Date.now(),
      } as Task);

      // Calendar parity: meeting types with usable Google auth get a Calendar event.
      if (norm.value.type === 'meeting') {
        const eventId = await googleService.addToCalendar({ ...norm.value, id: newId } as Task);
        if (eventId) {
          await db.tasks.update(newId, { googleEventId: eventId });
        }
      }

      return { success: true, newId: newId as number, last_error: norm.last_error };
    }

    if (write.action === 'update_task') {
      if (!data.id) return { success: false, last_error: 'task_data.id missing' };
      const existing = await db.tasks.get(data.id);
      if (!existing) return { success: false, last_error: 'task not found' };
      const norm = normalizeEntity(data, 'update', existing);
      await db.tasks.update(data.id, {
        ...norm.value,
        source: existing.source ?? 'agent',
        agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
        updatedAt: Date.now(),
      });
      return { success: true, last_error: norm.last_error };
    }

    if (write.action === 'complete_task') {
      if (!data.id) return { success: false, last_error: 'task_data.id missing' };
      const existing = await db.tasks.get(data.id);
      if (!existing) return { success: false, last_error: 'task not found' };
      const norm = normalizeEntity(data, 'complete', existing);
      await db.tasks.update(data.id, {
        ...norm.value,
        source: existing.source ?? 'agent',
        agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
        updatedAt: Date.now(),
      });
      // Google Tasks parity: complete the linked Google Task when googleId is set.
      const linked = existing as Task & { googleId?: string; googleListId?: string };
      if (linked.googleId) {
        await googleService.updateGoogleTask(linked.googleId, { status: 'completed' }, linked.googleListId);
      }
      return { success: true, last_error: norm.last_error };
    }

    // delete_task
    if (!data.id) return { success: false, last_error: 'task_data.id missing' };
    const existing = await db.tasks.get(data.id);
    if (!existing) return { success: false, last_error: 'task not found' };
    await db.tasks.update(data.id, {
      isDeleted: true,
      source: existing.source ?? 'agent',
      agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
      updatedAt: Date.now(),
    });
    // Calendar parity: clean up the linked Calendar event for meetings.
    const linked = existing as Task & { googleEventId?: string };
    if (linked.googleEventId) {
      await googleService.deleteFromCalendar(linked.googleEventId);
    }
    return { success: true };
  }

  private async applyWorklogAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = (write.worklog_data ?? {}) as Partial<WorkLog> & { id?: number };

    if (write.action === 'create_worklog') {
      if (!data.projectId) return { success: false, last_error: 'projectId required' };
      const project = await db.projects.get(data.projectId);
      if (!project || !project.isActive) return { success: false, last_error: 'project-not-found' };
      if (!data.date) return { success: false, last_error: 'date required' };
      if (typeof data.hours !== 'number' || data.hours <= 0) return { success: false, last_error: 'hours must be > 0' };
      const newId = await db.workLogs.add({
        ...data,
        source: 'agent',
        agent_write_id: write.id,
        updatedAt: Date.now(),
        createdAt: Date.now(),
      } as WorkLog);
      return { success: true, newId: newId as number };
    }

    if (write.action === 'update_worklog') {
      if (!data.id) return { success: false, last_error: 'worklog id missing' };
      const existing = await db.workLogs.get(data.id);
      if (!existing) return { success: false, last_error: 'worklog not found' };
      await db.workLogs.update(data.id, {
        ...data,
        source: existing.source,
        agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
        updatedAt: Date.now(),
      });
      return { success: true };
    }

    // delete_worklog: hard delete (worklogs are not soft-deleted in this app).
    if (!data.id) return { success: false, last_error: 'worklog id missing' };
    await db.workLogs.delete(data.id);
    return { success: true };
  }

  private async applyProjectAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = (write.project_data ?? {}) as Partial<Project> & { id?: number };

    if (write.action === 'create_project') {
      if (!data.name || data.name.trim().length === 0) return { success: false, last_error: 'name required' };
      // Re-activate an existing soft-deleted project with the same case-insensitive name.
      const all = await db.projects.toArray();
      const existingMatch = all.find(p => p.name.toLowerCase() === data.name!.toLowerCase());
      if (existingMatch) {
        await db.projects.update(existingMatch.id!, {
          isActive: true,
          color: data.color ?? existingMatch.color,
          source: 'agent',
          agent_write_id: write.id,
          updatedAt: Date.now(),
        });
        return { success: true, newId: existingMatch.id };
      }
      const newId = await db.projects.add({
        name: data.name.trim(),
        color: data.color ?? 'slate',
        isActive: true,
        source: 'agent',
        agent_write_id: write.id,
        updatedAt: Date.now(),
        createdAt: Date.now(),
      } as Project);
      return { success: true, newId: newId as number };
    }

    if (write.action === 'update_project') {
      if (!data.id) return { success: false, last_error: 'project id missing' };
      const existing = await db.projects.get(data.id);
      if (!existing) return { success: false, last_error: 'project not found' };
      await db.projects.update(data.id, {
        ...data,
        source: existing.source,
        agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
        updatedAt: Date.now(),
      });
      return { success: true };
    }

    // delete_project: soft delete (isActive: false). Existing worklogs pointing
    // at the project are not remapped; ProjectPicker already filters inactive.
    if (!data.id) return { success: false, last_error: 'project id missing' };
    const existing = await db.projects.get(data.id);
    if (!existing) return { success: false, last_error: 'project not found' };
    await db.projects.update(data.id, {
      isActive: false,
      source: existing.source,
      agent_write_id: existing.source === 'agent' ? (existing.agent_write_id ?? write.id) : undefined,
      updatedAt: Date.now(),
    });
    return { success: true };
  }

  // Settings keys the agent is allowed to delete. gemini_model is intentionally
  // non-deletable so the model picker does not fall back to undefined.
  private static readonly DELETABLE_SETTINGS: Record<string, true> = { gemini_api_key: true };

  private async applySettingsAction(
    write: AgentWrite
  ): Promise<ApplyWriteResult> {
    const data = write.settings_data;
    if (!data || !data.id) return { success: false, last_error: 'settings id required' };

    if (write.action === 'delete_settings') {
      if (!AgentBridge.DELETABLE_SETTINGS[data.id]) {
        return { success: false, last_error: 'key-not-deletable' };
      }
      await db.settings.delete(data.id);
      return { success: true };
    }

    // create_settings / update_settings: the put() is the same operation in
    // Dexie; the action name disambiguates intent.
    if (data.value === '' && data.id === 'gemini_api_key') {
      return { success: false, last_error: 'gemini_api_key cannot be empty' };
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
    return { success: true };
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
