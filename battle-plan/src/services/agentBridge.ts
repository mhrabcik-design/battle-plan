import type { Task } from '../db';

export interface AgentWrite {
  id: string;
  action: 'create_task' | 'update_task' | 'delete_task';
  task_data: Partial<Task> & { id?: number };
  created_at: number;
  applied_at?: number;
}

const FOLDER_NAME = 'Anu-BattlePlan';
const PENDING_FILE = 'agent-pending-writes.json';

class AgentBridge {
  private folderId: string | null = null;
  private fileId: string | null = null;
  private accessToken: string | null = null;
  private processedIds: Set<string> = new Set();
  private isInitialized = false;

  async init(): Promise<void> {
    if (this.isInitialized) return;
    if (!window.gapi?.client?.drive) {
      console.warn('AgentBridge: GAPI not available');
      return;
    }
    this.accessToken = localStorage.getItem('google_access_token');
    if (!this.accessToken) {
      console.warn('AgentBridge: Not signed in');
      return;
    }

    // Cache folder ID v localStorage (reuse vzor z googleService.ts)
    const cached = localStorage.getItem('bp_folder_id');
    if (cached) {
      this.folderId = cached;
    } else {
      try {
        const r = await window.gapi.client.drive.files.list({
          q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          spaces: 'drive', fields: 'files(id)', pageSize: 1,
        });
        if (r.result.files?.[0]) {
          this.folderId = r.result.files[0].id;
          localStorage.setItem('bp_folder_id', this.folderId);
        } else {
          console.warn('AgentBridge: Folder /Anu-BattlePlan/ not found');
          return;
        }
      } catch (e) {
        console.error('AgentBridge: Failed to find folder', e);
        return;
      }
    }
    this.isInitialized = true;
  }

  async fetchPendingWrites(): Promise<AgentWrite[]> {
    if (!this.isInitialized || !this.folderId || !this.accessToken) return [];

    try {
      // Najdi soubor
      const listR = await window.gapi.client.drive.files.list({
        q: `name='${PENDING_FILE}' and '${this.folderId}' in parents and trashed=false`,
        spaces: 'drive', fields: 'files(id)', pageSize: 1,
      });
      if (!listR.result.files?.[0]) return [];
      this.fileId = listR.result.files[0].id;

      // Stáhni obsah
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!resp.ok) return [];

      const data = await resp.json() as { writes?: AgentWrite[] };
      const writes: AgentWrite[] = (data.writes ?? []).filter(
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
    if (!this.fileId || !this.accessToken || writeIds.length === 0) return;

    try {
      // Stáhni aktuální stav
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!resp.ok) return;
      const data = await resp.json() as { writes?: AgentWrite[] };

      // Označ jako aplikované
      const now = Date.now();
      const writes: AgentWrite[] = (data.writes ?? []).map((w: AgentWrite) =>
        writeIds.includes(w.id) ? { ...w, applied_at: now } : w
      );

      // Upload zpět (stejný multipart pattern jako v googleService.ts saveToDrive)
      const updatedData = { ...data, writes };
      const fileContent = JSON.stringify(updatedData);
      const boundary = '-------314159265358979323846';
      const metadata = {
        name: PENDING_FILE,
        mimeType: 'application/json',
      };
      const body =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        fileContent + '\r\n' +
        '--' + boundary + '--';

      await window.gapi.client.request({
        path: `/upload/drive/v3/files/${this.fileId}?uploadType=multipart`,
        method: 'PATCH',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body,
      });

      // Přidej do processedIds pro případ, že by se soubor stáhl znovu
      for (const id of writeIds) this.processedIds.add(id);
    } catch (e) {
      console.error('AgentBridge: markApplied failed', e);
    }
  }

  get initialized(): boolean { return this.isInitialized; }
}

export const agentBridge = new AgentBridge();
