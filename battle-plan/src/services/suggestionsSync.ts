/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AgentSuggestion {
  id: string;
  created_at: number;
  source: string;
  category: 'task' | 'followup' | 'preparation' | 'reminder' | 'decision';
  title: string;
  description: string;
  context: {
    related_task_ids: number[];
    related_email_ids: string[];
    deadline: number | null;
    priority: 'high' | 'medium' | 'low';
  };
  status: 'open' | 'accepted' | 'rejected' | 'deferred' | 'converted';
  reply_count: number;
  last_reply_at: number | null;
  status_updated_at?: number;
}

export interface AgentSuggestionReply {
  id: string;
  suggestion_id: string;
  created_at: number;
  type: 'text' | 'voice' | 'action';
  content: string;
  voice_file_id?: string;
  action: 'accept' | 'reject' | 'defer' | null;
  action_data?: {
    convert_to_task?: boolean;
    defer_until?: string;
  };
}

interface SuggestionsFile {
  version?: number;
  last_updated?: number;
  suggestions: AgentSuggestion[];
}

interface RepliesFile {
  version?: number;
  last_updated?: number;
  replies: AgentSuggestionReply[];
}

const FOLDER_NAME = 'Anu-BattlePlan';
const SUGGESTIONS_FILENAME = 'agent-suggestions.json';
const REPLIES_FILENAME = 'agent-suggestion-replies.json';

class SuggestionsSync {
  private folderId: string | null = null;
  private suggestionsFileId: string | null = null;
  private repliesFileId: string | null = null;
  private accessToken: string | null = null;
  private knownReplyIds: Set<string> = new Set();
  private isInitialized = false;

  async init(): Promise<void> {
    if (this.isInitialized) return;
    if (!window.gapi?.client?.drive) {
      console.warn('SuggestionsSync: GAPI not available');
      return;
    }
    this.accessToken = localStorage.getItem('google_access_token');
    if (!this.accessToken) {
      console.warn('SuggestionsSync: Not signed in');
      return;
    }

    const cached = localStorage.getItem('bp_folder_id');
    if (cached) {
      this.folderId = cached;
    } else {
      try {
        const r = await window.gapi.client.drive.files.list({
          q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          spaces: 'drive',
          fields: 'files(id)',
          pageSize: 1,
        });
        if (r.result.files?.[0]) {
          this.folderId = r.result.files[0].id;
          localStorage.setItem('bp_folder_id', this.folderId);
        } else {
          console.warn('SuggestionsSync: Folder /Anu-BattlePlan/ not found');
          return;
        }
      } catch (e) {
        console.error('SuggestionsSync: Failed to find folder', e);
        return;
      }
    }
    this.isInitialized = true;
  }

  async fetchSuggestions(): Promise<AgentSuggestion[]> {
    if (!this.isInitialized || !this.folderId || !this.accessToken) return [];

    try {
      const listR = await window.gapi.client.drive.files.list({
        q: `name='${SUGGESTIONS_FILENAME}' and '${this.folderId}' in parents and trashed=false`,
        spaces: 'drive',
        fields: 'files(id)',
        pageSize: 1,
      });
      const fileMeta = listR.result.files?.[0];
      if (!fileMeta) return [];
      this.suggestionsFileId = fileMeta.id;

      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${this.suggestionsFileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!resp.ok) return [];

      const data = (await resp.json()) as SuggestionsFile;
      const all = data.suggestions ?? [];
      return all;
    } catch (e) {
      console.error('SuggestionsSync: fetchSuggestions failed', e);
      return [];
    }
  }

  async fetchReplies(suggestionId?: string): Promise<AgentSuggestionReply[]> {
    if (!this.isInitialized || !this.folderId || !this.accessToken) return [];

    try {
      const listR = await window.gapi.client.drive.files.list({
        q: `name='${REPLIES_FILENAME}' and '${this.folderId}' in parents and trashed=false`,
        spaces: 'drive',
        fields: 'files(id)',
        pageSize: 1,
      });
      const fileMeta = listR.result.files?.[0];
      if (!fileMeta) return [];
      this.repliesFileId = fileMeta.id;

      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${this.repliesFileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!resp.ok) return [];

      const data = (await resp.json()) as RepliesFile;
      let replies = data.replies ?? [];
      if (suggestionId) {
        replies = replies.filter((r) => r.suggestion_id === suggestionId);
      }
      return replies;
    } catch (e) {
      console.error('SuggestionsSync: fetchReplies failed', e);
      return [];
    }
  }

  async updateSuggestion(
    suggestionId: string,
    updates: { priority?: 'high' | 'medium' | 'low'; deadline?: number | null; title?: string; description?: string }
  ): Promise<{ success: boolean }> {
    if (!this.isInitialized || !this.suggestionsFileId || !this.accessToken) {
      return { success: false };
    }
    try {
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${this.suggestionsFileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!resp.ok) return { success: false };
      const data = (await resp.json()) as SuggestionsFile;
      const idx = (data.suggestions ?? []).findIndex((s) => s.id === suggestionId);
      if (idx === -1) return { success: false };

      const sug = data.suggestions[idx];
      if (updates.priority !== undefined) {
        sug.context = { ...(sug.context ?? { related_task_ids: [], related_email_ids: [], deadline: null, priority: 'medium' }), priority: updates.priority };
      }
      if (updates.deadline !== undefined) {
        sug.context = { ...(sug.context ?? { related_task_ids: [], related_email_ids: [], priority: 'medium' }), deadline: updates.deadline };
      }
      if (updates.title !== undefined) {
        sug.title = updates.title;
      }
      if (updates.description !== undefined) {
        sug.description = updates.description;
      }
      const updated = { ...data, suggestions: data.suggestions, last_updated: Date.now() };
      const fileContent = JSON.stringify(updated);
      const boundary = '-------314159265358979323846';
      const metadata = { name: SUGGESTIONS_FILENAME, mimeType: 'application/json' };
      const body =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        fileContent + '\r\n' +
        '--' + boundary + '--';
      await window.gapi.client.request({
        path: `/upload/drive/v3/files/${this.suggestionsFileId}?uploadType=multipart`,
        method: 'PATCH',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body,
      });
      return { success: true };
    } catch (e) {
      console.error('SuggestionsSync: updateSuggestion failed', e);
      return { success: false };
    }
  }

  async addReply(reply: Omit<AgentSuggestionReply, 'id' | 'created_at'>): Promise<{ success: boolean; id?: string }> {
    if (!this.isInitialized || !this.repliesFileId || !this.accessToken) {
      return { success: false };
    }

    const newReply: AgentSuggestionReply = {
      ...reply,
      id: `rpl_${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
    };

    try {
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${this.repliesFileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!resp.ok) return { success: false };

      const data = (await resp.json()) as RepliesFile;
      const replies = [...(data.replies ?? []), newReply];
      const updated = { ...data, replies, last_updated: Date.now() };
      const fileContent = JSON.stringify(updated);

      const boundary = '-------314159265358979323846';
      const metadata = { name: REPLIES_FILENAME, mimeType: 'application/json' };
      const body =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        fileContent + '\r\n' +
        '--' + boundary + '--';

      await window.gapi.client.request({
        path: `/upload/drive/v3/files/${this.repliesFileId}?uploadType=multipart`,
        method: 'PATCH',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body,
      });

      this.knownReplyIds.add(newReply.id);
      return { success: true, id: newReply.id };
    } catch (e) {
      console.error('SuggestionsSync: addReply failed', e);
      return { success: false };
    }
  }

  async uploadVoiceReply(suggestionId: string, blob: Blob): Promise<{ success: boolean; fileId?: string }> {
    if (!this.isInitialized || !this.folderId || !this.accessToken) {
      return { success: false };
    }

    try {
      const safeName = `voice-reply-${suggestionId}-${Date.now()}.webm`;
      const metadata = {
        name: safeName,
        parents: [this.folderId],
        mimeType: 'audio/webm',
      };

      const boundary = '-------314159265358979323846';
      const body =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: audio/webm\r\n\r\n';

      const head = new TextEncoder().encode(body);
      const tail = new TextEncoder().encode('\r\n--' + boundary + '--');
      const combined = new Blob([head, blob, tail], { type: 'multipart/related' });

      const resp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: combined,
        }
      );

      if (!resp.ok) {
        const errText = await resp.text();
        console.error('Voice upload failed:', errText);
        return { success: false };
      }

      const result = await resp.json();
      return { success: true, fileId: result.id };
    } catch (e) {
      console.error('SuggestionsSync: uploadVoiceReply failed', e);
      return { success: false };
    }
  }

  get initialized(): boolean { return this.isInitialized; }
  get hasKnownReplies(): boolean { return this.knownReplyIds.size > 0; }
  markRepliesKnown(replyIds: string[]): void {
    for (const id of replyIds) this.knownReplyIds.add(id);
  }
}

export const suggestionsSync = new SuggestionsSync();
