import { DriveJsonStore, type DriveStoreStatus } from './driveJsonStore';

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

export type SuggestionsFetchResult =
  | { kind: 'loaded'; suggestions: AgentSuggestion[] }
  | { kind: 'missing-file'; suggestions: AgentSuggestion[] }
  | { kind: 'store-unavailable'; status: DriveStoreStatus; suggestions: AgentSuggestion[] }
  | { kind: 'error'; message: string; suggestions: AgentSuggestion[] };

const SUGGESTIONS_FILENAME = 'agent-suggestions.json';
const REPLIES_FILENAME = 'agent-suggestion-replies.json';

class SuggestionsSync {
  private suggestionsFileId: string | null = null;
  private repliesFileId: string | null = null;
  private knownReplyIds: Set<string> = new Set();
  private isInitialized = false;
  private readonly drive = new DriveJsonStore();

  async init(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = await this.drive.init({ createFolder: true });
  }

  async fetchSuggestions(): Promise<AgentSuggestion[]> {
    const result = await this.fetchSuggestionsDetailed();
    return result.suggestions;
  }

  async fetchSuggestionsDetailed(): Promise<SuggestionsFetchResult> {
    if (!this.isInitialized) {
      return { kind: 'store-unavailable', status: this.drive.lastStatus, suggestions: [] };
    }

    try {
      const result = await this.drive.readJsonFileWithStatus<SuggestionsFile>(SUGGESTIONS_FILENAME);
      if (result.kind === 'missing-file') return { kind: 'missing-file', suggestions: [] };
      if (result.kind === 'store-unavailable') return { ...result, suggestions: [] };
      if (result.kind === 'error') return { ...result, suggestions: [] };
      this.suggestionsFileId = result.fileId;
      return { kind: 'loaded', suggestions: result.data.suggestions ?? [] };
    } catch (e) {
      console.error('SuggestionsSync: fetchSuggestions failed', e);
      return { kind: 'error', message: e instanceof Error ? e.message : String(e), suggestions: [] };
    }
  }

  async fetchReplies(suggestionId?: string): Promise<AgentSuggestionReply[]> {
    if (!this.isInitialized) return [];

    try {
      const loaded = await this.drive.readJsonFile<RepliesFile>(REPLIES_FILENAME);
      if (!loaded) return [];
      this.repliesFileId = loaded.fileId;
      let replies = loaded.data.replies ?? [];
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
    if (!this.isInitialized || !this.suggestionsFileId) {
      return { success: false };
    }
    try {
      const loaded = await this.drive.readJsonFile<SuggestionsFile>(SUGGESTIONS_FILENAME);
      if (!loaded) return { success: false };
      this.suggestionsFileId = loaded.fileId;
      const data = loaded.data;
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

      return await this.writeSuggestions({ ...data, suggestions: data.suggestions, last_updated: Date.now() });
    } catch (e) {
      console.error('SuggestionsSync: updateSuggestion failed', e);
      return { success: false };
    }
  }

  async updateSuggestionStatus(
    suggestionId: string,
    status: 'open' | 'accepted' | 'rejected' | 'deferred' | 'converted'
  ): Promise<{ success: boolean }> {
    if (!this.isInitialized || !this.suggestionsFileId) {
      return { success: false };
    }
    try {
      const loaded = await this.drive.readJsonFile<SuggestionsFile>(SUGGESTIONS_FILENAME);
      if (!loaded) return { success: false };
      this.suggestionsFileId = loaded.fileId;
      const data = loaded.data;
      const idx = (data.suggestions ?? []).findIndex((s) => s.id === suggestionId);
      if (idx === -1) return { success: false };
      data.suggestions[idx].status = status;
      data.suggestions[idx].status_updated_at = Date.now();
      return await this.writeSuggestions({ ...data, last_updated: Date.now() });
    } catch (e) {
      console.error('SuggestionsSync: updateSuggestionStatus failed', e);
      return { success: false };
    }
  }

  async deleteSuggestion(suggestionId: string): Promise<{ success: boolean }> {
    if (!this.isInitialized || !this.suggestionsFileId) {
      return { success: false };
    }
    try {
      const [loadedSuggestions, loadedReplies] = await Promise.all([
        this.drive.readJsonFile<SuggestionsFile>(SUGGESTIONS_FILENAME),
        this.drive.readJsonFile<RepliesFile>(REPLIES_FILENAME),
      ]);
      if (!loadedSuggestions) return { success: false };
      this.suggestionsFileId = loadedSuggestions.fileId;
      const nextSuggestions = (loadedSuggestions.data.suggestions ?? []).filter((s) => s.id !== suggestionId);
      await this.writeSuggestions({ ...loadedSuggestions.data, suggestions: nextSuggestions, last_updated: Date.now() });
      if (loadedReplies) {
        this.repliesFileId = loadedReplies.fileId;
        const nextReplies = (loadedReplies.data.replies ?? []).filter((r) => r.suggestion_id !== suggestionId);
        await this.writeReplies({ ...loadedReplies.data, replies: nextReplies, last_updated: Date.now() });
      }
      return { success: true };
    } catch (e) {
      console.error('SuggestionsSync: deleteSuggestion failed', e);
      return { success: false };
    }
  }

  async addReply(reply: Omit<AgentSuggestionReply, 'id' | 'created_at'>): Promise<{ success: boolean; id?: string }> {
    if (!this.isInitialized || !this.repliesFileId) {
      return { success: false };
    }

    const newReply: AgentSuggestionReply = {
      ...reply,
      id: `rpl_${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
    };

    try {
      const loaded = await this.drive.readJsonFile<RepliesFile>(REPLIES_FILENAME);
      if (!loaded) return { success: false };
      this.repliesFileId = loaded.fileId;
      const replies = [...(loaded.data.replies ?? []), newReply];
      const saved = await this.drive.writeJsonFile(
        REPLIES_FILENAME,
        { ...loaded.data, replies, last_updated: Date.now() },
        this.repliesFileId,
      );
      if (!saved) return { success: false };

      this.knownReplyIds.add(newReply.id);
      return { success: true, id: newReply.id };
    } catch (e) {
      console.error('SuggestionsSync: addReply failed', e);
      return { success: false };
    }
  }

  async uploadVoiceReply(suggestionId: string, blob: Blob): Promise<{ success: boolean; fileId?: string }> {
    if (!this.isInitialized) return { success: false };

    try {
      const safeName = `voice-reply-${suggestionId}-${Date.now()}.webm`;
      const uploaded = await this.drive.uploadBlob(safeName, blob, 'audio/webm');
      return uploaded?.fileId ? { success: true, fileId: uploaded.fileId } : { success: false };
    } catch (e) {
      console.error('SuggestionsSync: uploadVoiceReply failed', e);
      return { success: false };
    }
  }

  get initialized(): boolean { return this.isInitialized; }
  get status(): DriveStoreStatus { return this.drive.lastStatus; }
  get hasKnownReplies(): boolean { return this.knownReplyIds.size > 0; }
  markRepliesKnown(replyIds: string[]): void {
    for (const id of replyIds) this.knownReplyIds.add(id);
  }

  private async writeSuggestions(data: SuggestionsFile): Promise<{ success: boolean }> {
    const saved = await this.drive.writeJsonFile(SUGGESTIONS_FILENAME, data, this.suggestionsFileId);
    if (!saved) return { success: false };
    if (saved.fileId) {
      this.suggestionsFileId = saved.fileId;
    }
    return { success: true };
  }

  private async writeReplies(data: RepliesFile): Promise<{ success: boolean }> {
    const saved = await this.drive.writeJsonFile(REPLIES_FILENAME, data, this.repliesFileId);
    if (!saved) return { success: false };
    if (saved.fileId) {
      this.repliesFileId = saved.fileId;
    }
    return { success: true };
  }
}

export const suggestionsSync = new SuggestionsSync();
