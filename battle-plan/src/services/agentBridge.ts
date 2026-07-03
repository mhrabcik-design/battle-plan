import type { Task } from '../db';
import { DriveJsonStore } from './driveJsonStore';

export interface AgentWrite {
  id: string;
  action: 'create_task' | 'update_task' | 'delete_task';
  task_data: Partial<Task> & { id?: number };
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

  async init(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = await this.drive.init();
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

  async applyWrite(write: AgentWrite): Promise<{ success: boolean; newId?: number }> {
    const { db } = await import('../db');

    try {
      if (write.action === 'create_task') {
        const newId = await db.tasks.add({
          ...write.task_data,
          status: write.task_data.status || 'pending',
          updatedAt: Date.now(),
          createdAt: Date.now(),
        } as Task);
        return { success: true, newId: newId as number };
      }

      if (write.action === 'update_task' && write.task_data.id) {
        await db.tasks.update(write.task_data.id, {
          ...write.task_data,
          updatedAt: Date.now(),
        });
        return { success: true };
      }

      if (write.action === 'delete_task' && write.task_data.id) {
        await db.tasks.update(write.task_data.id, { isDeleted: true, updatedAt: Date.now() });
        return { success: true };
      }

      return { success: false };
    } catch (e) {
      console.error('AgentBridge: applyWrite failed', e);
      return { success: false };
    }
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
