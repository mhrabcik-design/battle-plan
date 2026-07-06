import { googleService } from './googleService';
import { normalizeEntity } from './semanticEngine';
import type { AgentInboxRow, Project, Task, WorkLog } from '../db';
import { db } from '../db';
import { DriveJsonStore } from './driveJsonStore';

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

// Per-action data shapes. `task_data` is preserved at the AgentWrite top level
// for the task-shaped actions (back-compat with the original wire format);
// worklog / project / settings actions carry their data in a typed sub-payload.
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

class AgentBridge {
  private fileId: string | null = null;
  private processedIds: Set<string> = new Set();
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
        (w: AgentWrite) => !w.applied_at && !this.processedIds.has(w.id)
      );
      return writes;
    } catch (e) {
      console.error('AgentBridge: fetchPendingWrites failed', e);
      return [];
    }
  }

  async applyWrite(write: AgentWrite): Promise<{ success: boolean; newId?: number; last_error?: string }> {
    try {
      // Dispatch the four task-shaped actions through normalizeEntity so the
      // agent path produces the same invariants as the voice path.
      if (
        write.action === 'create_task' ||
        write.action === 'update_task' ||
        write.action === 'delete_task' ||
        write.action === 'complete_task'
      ) {
        return await this.applyTaskAction(write);
      }
      // Non-task actions land here; U4 adds the worklog/project/settings
      // branches with the per-entity normalization from R3a-R3c.
      return { success: false, last_error: `unsupported action: ${write.action}` };
    } catch (e) {
      console.error('AgentBridge: applyWrite failed', e);
      return { success: false, last_error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async applyTaskAction(
    write: AgentWrite
  ): Promise<{ success: boolean; newId?: number; last_error?: string }> {
    if (
      write.action !== 'create_task' && write.action !== 'update_task' &&
      write.action !== 'delete_task' && write.action !== 'complete_task'
    ) {
      return { success: false, last_error: 'not a task action' };
    }
    const data = (write.task_data ?? {}) as Partial<Task> & { id?: number };

    if (write.action === 'create_task') {
      const norm = normalizeEntity(data, 'create', undefined);
      const newId = await db.tasks.add({
        ...norm.value,
        status: norm.value.status ?? 'pending',
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

  get initialized(): boolean { return this.isInitialized; }
}

export const agentBridge = new AgentBridge();
