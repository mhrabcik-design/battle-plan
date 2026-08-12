import {
  DriveJsonStore,
  type DriveStoreStatus,
  type DriveJsonWrite,
} from './driveJsonStore.ts';
import type { ProposalPayload } from './agentProtocol/contracts.ts';
import { getErrorMessage } from '../utils/errors.ts';

export interface AgentSuggestion extends Partial<Pick<
  ProposalPayload,
  'subject_id' | 'occurrence_key' | 'source_refs'
>> {
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

export type RepliesFetchResult =
  | { kind: 'loaded'; replies: AgentSuggestionReply[] }
  | { kind: 'missing-file'; replies: AgentSuggestionReply[] }
  | { kind: 'store-unavailable'; status: DriveStoreStatus; replies: AgentSuggestionReply[] }
  | { kind: 'error'; message: string; replies: AgentSuggestionReply[] };

const SUGGESTIONS_FILENAME = 'agent-suggestions.json';
const REPLIES_FILENAME = 'agent-suggestion-replies.json';

export type SuggestionsStore = Pick<
  DriveJsonStore,
  'lastStatus' | 'init' | 'readJsonFile' | 'readJsonFileWithStatus' | 'readJsonFilesWithStatus'
  | 'writeJsonFile' | 'trashFile' | 'uploadBlob'
>;

export class SuggestionsSync {
  private suggestionsFileId: string | null = null;
  private repliesFileId: string | null = null;
  private knownReplyIds: Set<string> = new Set();
  private isInitialized = false;
  private readonly drive: SuggestionsStore;

  constructor(drive: SuggestionsStore = new DriveJsonStore()) {
    this.drive = drive;
  }

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
      return { kind: 'error', message: getErrorMessage(e), suggestions: [] };
    }
  }

  async fetchReplies(suggestionId?: string): Promise<AgentSuggestionReply[]> {
    const result = await this.fetchRepliesDetailed(suggestionId);
    return result.replies;
  }

  async fetchRepliesDetailed(suggestionId?: string): Promise<RepliesFetchResult> {
    if (!this.isInitialized) {
      return { kind: 'store-unavailable', status: this.drive.lastStatus, replies: [] };
    }

    try {
      const result = await this.drive.readJsonFileWithStatus<RepliesFile>(REPLIES_FILENAME);
      if (result.kind === 'missing-file') return { kind: 'missing-file', replies: [] };
      if (result.kind === 'store-unavailable') return { ...result, replies: [] };
      if (result.kind === 'error') return { ...result, replies: [] };

      this.repliesFileId = result.fileId;
      let replies = result.data.replies ?? [];
      if (suggestionId) {
        replies = replies.filter((r) => r.suggestion_id === suggestionId);
      }
      return { kind: 'loaded', replies };
    } catch (e) {
      console.error('SuggestionsSync: fetchReplies failed', e);
      return { kind: 'error', message: getErrorMessage(e), replies: [] };
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
    if (!this.isInitialized) {
      return { success: false };
    }

    const newReply: AgentSuggestionReply = {
      ...reply,
      id: `rpl_${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const loaded = await this.drive.readJsonFilesWithStatus<RepliesFile>(REPLIES_FILENAME);
        if (loaded.kind === 'store-unavailable' || loaded.kind === 'error') return { success: false };
        const files = loaded.kind === 'loaded' ? loaded.files : [];
        const canonical = files[0];
        if (canonical && !canonical.etag) return { success: false };

        const byId = new Map<string, AgentSuggestionReply>();
        for (const file of files) {
          for (const existing of file.data.replies ?? []) byId.set(existing.id, existing);
        }
        byId.set(newReply.id, newReply);
        const replies = [...byId.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
        let saved: DriveJsonWrite | null;
        try {
          saved = await this.drive.writeJsonFile(
            REPLIES_FILENAME,
            { version: 1, replies, last_updated: Date.now() },
            canonical?.fileId ?? null,
            canonical
              ? { ifMatch: canonical.etag }
              : { createOnly: true },
          );
        } catch (error) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 412) continue;
          throw error;
        }
        if (!saved) continue;

        const verification = await this.drive.readJsonFilesWithStatus<RepliesFile>(REPLIES_FILENAME);
        if (verification.kind !== 'loaded') continue;
        const verifiedCanonical = verification.files[0];
        const remoteIds = new Set((verifiedCanonical.data.replies ?? []).map((item) => item.id));
        const allRemoteIds = new Set(
          verification.files.flatMap((file) => (file.data.replies ?? []).map((item) => item.id)),
        );
        if ([...allRemoteIds].some((id) => !remoteIds.has(id))) continue;
        if (!remoteIds.has(newReply.id)) continue;

        for (const duplicate of verification.files.slice(1)) {
          await this.drive.trashFile(duplicate.fileId);
        }
        this.repliesFileId = verifiedCanonical.fileId;
        this.knownReplyIds.add(newReply.id);
        return { success: true, id: newReply.id };
      }
      return { success: false };
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
