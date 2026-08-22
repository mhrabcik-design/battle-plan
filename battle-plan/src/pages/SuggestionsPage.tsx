import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Inbox, RefreshCw, Filter } from 'lucide-react';
import {
  suggestionsSync,
  type AgentSuggestion,
  type AgentSuggestionReply,
} from '../services/suggestionsSync';
import {
  effectiveSuggestionStatus,
  suggestionRegistry,
  type SuggestionResolution,
} from '../services/suggestionRegistry';
import {
  suggestionRegistrySync,
  type SuggestionRegistryPublishResult,
} from '../services/suggestionRegistrySync';
import { SuggestionCard } from '../components/SuggestionCard';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';
import { resolveSuggestionsSnapshot } from '../utils/suggestionReplies';
import {
  describeSuggestionPartialSync,
  type SuggestionLegacyMirrors,
} from '../utils/suggestionSyncDiagnostics';

type FilterMode = 'all' | 'open' | 'accepted' | 'rejected' | 'deferred' | 'converted';

const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
  { value: 'all', label: 'Vše' },
  { value: 'open', label: 'Otevřené' },
  { value: 'accepted', label: 'Přijaté' },
  { value: 'rejected', label: 'Zamítnuté' },
  { value: 'deferred', label: 'Odložené' },
  { value: 'converted', label: 'Hotovo' },
];

interface SuggestionsPageProps {
  // U8: consume the new four-state GoogleAuthStatus shape; the legacy
  // googleAuthForLegacyPages shim in App.tsx is no longer needed.
  googleAuth: GoogleAuthStatus;
  onAddLog: (message: string, type?: 'info' | 'error') => void;
}

export function SuggestionsPage({ googleAuth, onAddLog }: SuggestionsPageProps) {
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);
  const [repliesBySuggestion, setRepliesBySuggestion] = useState<Record<string, AgentSuggestionReply[]>>({});
  const [resolutionsBySuggestion, setResolutionsBySuggestion] = useState<Record<string, SuggestionResolution>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<FilterMode>('open');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [expandedTextFor, setExpandedTextFor] = useState<string | null>(null);
  const loadInFlightRef = useRef(false);

  const resolveAll = useCallback(async (values: readonly AgentSuggestion[]) => {
    const resolutions = await suggestionRegistry.resolveMany(values);
    const entries = values.map((suggestion, index) => [suggestion.id, resolutions[index]] as const);
    return Object.fromEntries(entries);
  }, []);

  const refreshResolution = useCallback(async (suggestion: AgentSuggestion) => {
    const resolution = await suggestionRegistry.resolve(suggestion);
    setResolutionsBySuggestion((previous) => ({ ...previous, [suggestion.id]: resolution }));
  }, []);

  const reportPartialSync = (
    action: string,
    registryResult: SuggestionRegistryPublishResult,
    mirrors: SuggestionLegacyMirrors,
  ) => {
    const message = describeSuggestionPartialSync(action, registryResult, mirrors);
    if (message) onAddLog(message, 'error');
  };

  const loadAll = useCallback(async () => {
    if (!hasUsableAuth(googleAuth)) return;
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setIsLoading(true);
    try {
      await suggestionsSync.init();
      if (!suggestionsSync.initialized) {
        onAddLog('SuggestionsSync: BP složka nenalezena. Otevři BP app a nech poprvé synchronizovat.', 'error');
        return;
      }
      const [suggestionsResult, repliesResult, registryFetch] = await Promise.all([
        suggestionsSync.fetchSuggestionsDetailed(),
        suggestionsSync.fetchRepliesDetailed(),
        suggestionRegistrySync.fetchAndMerge(),
      ]);

      if (suggestionsResult.kind === 'store-unavailable' || suggestionsResult.kind === 'error') {
        const message = suggestionsResult.kind === 'error'
          ? suggestionsResult.message
          : suggestionsResult.status.message;
        onAddLog(`Suggestions: Návrhy se nepodařilo načíst (${message})`, 'error');
        return;
      }
      const sugs = suggestionsResult.suggestions;

      const snapshot = resolveSuggestionsSnapshot(sugs, repliesResult);
      if (snapshot.kind === 'preserve') {
        console.error(snapshot.message);
        onAddLog(snapshot.message, 'error');
        return;
      }

      if (registryFetch.kind === 'error' || registryFetch.kind === 'store-unavailable') {
        const message = registryFetch.kind === 'error'
          ? registryFetch.message
          : registryFetch.status?.message ?? 'Registr rozhodnutí není na Google Drive dostupný.';
        setSuggestions([]);
        setRepliesBySuggestion({});
        setResolutionsBySuggestion({});
        setExpandedTextFor(null);
        onAddLog(`Suggestions: Návrhy jsou pozastavené, dokud se nenačte registr rozhodnutí (${message})`, 'error');
        return;
      }
      const replies = Object.values(snapshot.repliesBySuggestion).flat();
      await suggestionRegistry.ingestLegacy(sugs, replies);
      const registryPublish = await suggestionRegistrySync.publishPending();
      if (registryPublish.kind === 'error') {
        console.warn('Suggestion decision registry publish failed', registryPublish.message);
      }

      setSuggestions(sugs);
      setRepliesBySuggestion(snapshot.repliesBySuggestion);
      setResolutionsBySuggestion(await resolveAll(sugs));
    } catch (e) {
      console.error('Load suggestions failed', e);
      onAddLog('Suggestions: Nepodařilo se načíst návrhy', 'error');
    } finally {
      loadInFlightRef.current = false;
      setIsLoading(false);
    }
  }, [googleAuth, onAddLog, resolveAll]);

  useEffect(() => {
    queueMicrotask(() => {
      loadAll();
    });
    const t = setInterval(loadAll, 30_000);
    return () => clearInterval(t);
  }, [loadAll]);

  const counts = useMemo(() => {
    const c = { open: 0, accepted: 0, rejected: 0, deferred: 0, converted: 0 };
    for (const s of suggestions) {
      const status = effectiveSuggestionStatus(s, resolutionsBySuggestion[s.id]);
      if (status in c) c[status as keyof typeof c]++;
    }
    return c;
  }, [suggestions, resolutionsBySuggestion]);

  const filtered = useMemo(() => {
    const sorted = [...suggestions].sort((a, b) => b.created_at - a.created_at);
    if (filter === 'all') return sorted;
    return sorted.filter((s) => effectiveSuggestionStatus(s, resolutionsBySuggestion[s.id]) === filter);
  }, [suggestions, resolutionsBySuggestion, filter]);

  const acceptAndCreateTask = async (suggestion: AgentSuggestion) => {
    setProcessingId(suggestion.id);
    try {
      // Create task in BP
      const deadline = suggestion.context.deadline
        ? new Date(suggestion.context.deadline).toISOString().split('T')[0]
        : undefined;

      // Build description with embedded reply notes (text + voice transcripts)
      const noteReplies = (repliesBySuggestion[suggestion.id] ?? []).filter(
        (r) => r.content && r.content.trim() && r.type !== 'action'
      );
      const noteSection = noteReplies.length > 0
        ? '\n\n---\n📝 **Poznámky od tebe:**\n' +
          noteReplies
            .map((r) => {
              const ts = new Date(r.created_at).toLocaleString('cs-CZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
              const voiceTag = r.type === 'voice' ? ' 🎙' : '';
              return `- ${ts}${voiceTag}: ${r.content.trim()}`;
            })
            .join('\n')
        : '';
      const fullDescription = (suggestion.description ?? '') + noteSection;
      const now = new Date().getTime();

      const conversion = await suggestionRegistry.convertToTask(suggestion, {
        title: suggestion.title,
        description: fullDescription,
        type: 'task',
        status: 'pending',
        urgency: suggestion.context.priority === 'high' ? 3 : suggestion.context.priority === 'low' ? 1 : 2,
        date: deadline,
        deadline: deadline,
        createdAt: now,
        updatedAt: now,
      });
      const taskId = conversion.task.id!;

      const [registryResult, replyResult, statusResult] = await Promise.all([
        suggestionRegistrySync.publishPending(),
        suggestionsSync.addReply({
        suggestion_id: suggestion.id,
        type: 'action',
        content: `Accepted → task #${taskId}`,
        action: 'accept',
        action_data: { convert_to_task: true },
        }),
        suggestionsSync.updateSuggestionStatus(suggestion.id, 'converted'),
      ]);
      reportPartialSync('task byl vytvořen', registryResult, {
        replyMirror: replyResult.success,
        producerStatusMirror: statusResult.success,
        primaryArtifact: 'decision-and-task',
      });

      // Local optimistic update
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === suggestion.id
            ? { ...s, status: 'converted' as const, status_updated_at: Date.now() }
            : s
        )
      );
      await refreshResolution(suggestion);

      const retryLabel = conversion.outcome === 'existing' ? ' (už existoval)' : '';
      onAddLog(`Suggestions: ✅ ${suggestion.title.slice(0, 50)} → task #${taskId}${retryLabel}`);
    } catch (e) {
      console.error('Accept failed', e);
      onAddLog(`Suggestions: Chyba při vytváření tasku: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setProcessingId(null);
    }
  };

  const reject = async (suggestion: AgentSuggestion) => {
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, { kind: 'rejected' });
      const [registryResult, replyResult, statusResult] = await Promise.all([
        suggestionRegistrySync.publishPending(),
        suggestionsSync.addReply({
          suggestion_id: suggestion.id,
          type: 'action',
          content: 'Rejected',
          action: 'reject',
        }),
        suggestionsSync.updateSuggestionStatus(suggestion.id, 'rejected'),
      ]);
      reportPartialSync('zamítnutí bylo zaznamenáno', registryResult, {
        replyMirror: replyResult.success,
        producerStatusMirror: statusResult.success,
      });
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === suggestion.id
            ? { ...s, status: 'rejected' as const, status_updated_at: Date.now() }
            : s
        )
      );
      await refreshResolution(suggestion);
      onAddLog(`Suggestions: ❌ Zamítnuto: ${suggestion.title.slice(0, 50)}`);
    } catch (e) {
      console.error('Reject failed', e);
      onAddLog('Suggestions: Zamítnutí se nepodařilo uložit', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  const deleteSuggestion = async (suggestion: AgentSuggestion) => {
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, { kind: 'dismissed' });
      const registryResult = await suggestionRegistrySync.publishPending();
      const result = await suggestionsSync.deleteSuggestion(suggestion.id);
      reportPartialSync('smazání bylo zaznamenáno', registryResult, {
        deletionMirror: {
          suggestions: result.suggestions,
          replies: result.replies,
        },
      });
      if (result.success) {
        setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
        setRepliesBySuggestion((prev) => {
          const next = { ...prev };
          delete next[suggestion.id];
          return next;
        });
        onAddLog(`Suggestions: Smazáno: ${suggestion.title.slice(0, 50)}`);
      } else {
        onAddLog('Suggestions: Smazat návrh selhalo', 'error');
      }
    } catch (e) {
      console.error('Delete suggestion failed', e);
      onAddLog('Suggestions: Smazat návrh selhalo', 'error');
    } finally {
      setProcessingId(null);
    }
  };

   const defer = async (suggestion: AgentSuggestion, deferUntil: string) => {
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, {
        kind: 'deferred',
        deferUntil: new Date(`${deferUntil}T00:00:00`).getTime(),
      });
      const [registryResult, replyResult, statusResult] = await Promise.all([
        suggestionRegistrySync.publishPending(),
        suggestionsSync.addReply({
          suggestion_id: suggestion.id,
          type: 'action',
          content: `Deferred to ${deferUntil}`,
          action: 'defer',
          action_data: { defer_until: deferUntil },
        }),
        suggestionsSync.updateSuggestionStatus(suggestion.id, 'deferred'),
      ]);
      reportPartialSync('odložení bylo zaznamenáno', registryResult, {
        replyMirror: replyResult.success,
        producerStatusMirror: statusResult.success,
      });
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === suggestion.id
            ? { ...s, status: 'deferred' as const, status_updated_at: Date.now() }
            : s
        )
      );
      await refreshResolution(suggestion);
      onAddLog(`Suggestions: ⏰ Odloženo do ${deferUntil}: ${suggestion.title.slice(0, 50)}`);
    } catch (e) {
      console.error('Defer failed', e);
      onAddLog('Suggestions: Odložení se nepodařilo uložit', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  const sendTextReply = async (suggestion: AgentSuggestion, text: string) => {
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, { kind: 'commented', comment: text });
      const [registryResult, result] = await Promise.all([
        suggestionRegistrySync.publishPending(),
        suggestionsSync.addReply({
          suggestion_id: suggestion.id,
          type: 'text',
          content: text,
          action: null,
        }),
      ]);
      reportPartialSync('komentář byl zaznamenán', registryResult, {
        replyMirror: result.success,
      });
      if (result.success && result.id) {
        setRepliesBySuggestion((prev) => ({
          ...prev,
          [suggestion.id]: [
            ...(prev[suggestion.id] ?? []),
            {
              id: result.id!,
              suggestion_id: suggestion.id,
              created_at: Date.now(),
              type: 'text',
              content: text,
              action: null,
            },
          ],
        }));
        await refreshResolution(suggestion);
        onAddLog(`Suggestions: 💬 Text reply odeslán`);
      }
    } catch (e) {
      console.error('Text reply failed', e);
    } finally {
      setProcessingId(null);
    }
  };

  const sendVoiceReply = async (suggestion: AgentSuggestion, blob: Blob) => {
    setProcessingId(suggestion.id);
    try {
      const upload = await suggestionsSync.uploadVoiceReply(suggestion.id, blob);
      if (!upload.success || !upload.fileId) {
        onAddLog('Suggestions: Nahrávání hlasu selhalo', 'error');
        return;
      }
      await suggestionRegistry.recordDecision(suggestion, { kind: 'commented', comment: 'Hlasová reakce' });
      const [registryResult, result] = await Promise.all([
        suggestionRegistrySync.publishPending(),
        suggestionsSync.addReply({
          suggestion_id: suggestion.id,
          type: 'voice',
          content: '',
          voice_file_id: upload.fileId,
          action: null,
        }),
      ]);
      reportPartialSync('hlasová reakce byla zaznamenána', registryResult, {
        replyMirror: result.success,
      });
      if (result.success && result.id) {
        setRepliesBySuggestion((prev) => ({
          ...prev,
          [suggestion.id]: [
            ...(prev[suggestion.id] ?? []),
            {
              id: result.id!,
              suggestion_id: suggestion.id,
              created_at: Date.now(),
              type: 'voice',
              content: '',
              voice_file_id: upload.fileId,
              action: null,
            },
          ],
        }));
        await refreshResolution(suggestion);
        onAddLog(`Suggestions: 🎙 Hlasová reakce uložena`);
      }
    } catch (e) {
      console.error('Voice reply failed', e);
      onAddLog('Suggestions: Hlasová reakce selhala', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  const confirmSameSuggestion = async (suggestion: AgentSuggestion, targetOccurrenceKey: string) => {
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.confirmSameOccurrence(suggestion, targetOccurrenceKey);
      const registryResult = await suggestionRegistrySync.publishPending();
      reportPartialSync('sloučení návrhů bylo zaznamenáno', registryResult, {});
      await refreshResolution(suggestion);
      onAddLog(`Suggestions: Duplicitní návrh „${suggestion.title.slice(0, 50)}“ byl sloučen.`);
    } catch (e) {
      console.error('Confirm duplicate suggestion failed', e);
      onAddLog('Suggestions: Sloučení návrhů se nepodařilo', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  const confirmDistinctSuggestion = async (suggestion: AgentSuggestion, targetOccurrenceKey: string) => {
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.confirmDistinctSubjects(suggestion, targetOccurrenceKey);
      const registryResult = await suggestionRegistrySync.publishPending();
      reportPartialSync('nová samostatná událost byla zaznamenána', registryResult, {});
      await refreshResolution(suggestion);
      onAddLog(`Suggestions: „${suggestion.title.slice(0, 50)}“ zůstává jako nový návrh.`);
    } catch (e) {
      console.error('Confirm distinct suggestion failed', e);
      onAddLog('Suggestions: Rozlišení návrhů se nepodařilo', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  const updateSuggestion = async (
    suggestion: AgentSuggestion,
    updates: { priority?: 'high' | 'medium' | 'low'; deadline?: number | null }
  ) => {
    setProcessingId(suggestion.id);
    try {
      const ok = await suggestionsSync.updateSuggestion(suggestion.id, updates);
      if (!ok.success) {
        onAddLog('Suggestions: Úprava selhala', 'error');
        return;
      }
      // Log edit reply for audit
      const parts: string[] = [];
      if (updates.priority !== undefined) parts.push(`priorita → ${updates.priority}`);
      if (updates.deadline !== undefined) {
        parts.push(
          updates.deadline === null
            ? 'deadline smazán'
            : `deadline → ${new Date(updates.deadline).toISOString().split('T')[0]}`
        );
      }
      const editReply = await suggestionsSync.addReply({
        suggestion_id: suggestion.id,
        type: 'text',
        content: `✏️ ${parts.join(', ')}`,
        action: null,
      });
      // Local optimistic update
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === suggestion.id
            ? {
                ...s,
                context: {
                  ...s.context,
                  ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
                  ...(updates.deadline !== undefined ? { deadline: updates.deadline } : {}),
                },
              }
            : s
        )
      );
      if (editReply.success && editReply.id) {
        setRepliesBySuggestion((prev) => ({
          ...prev,
          [suggestion.id]: [
            ...(prev[suggestion.id] ?? []),
            {
              id: editReply.id!,
              suggestion_id: suggestion.id,
              created_at: Date.now(),
              type: 'text',
              content: `✏️ ${parts.join(', ')}`,
              action: null,
            },
          ],
        }));
      }
      onAddLog(`Suggestions: ✏️ Upraveno: ${suggestion.title.slice(0, 50)}`);
    } catch (e) {
      console.error('Update suggestion failed', e);
      onAddLog('Suggestions: Úprava selhala', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  if (!hasUsableAuth(googleAuth)) {
    return (
      <div className="p-12 text-center">
        <Inbox className="w-12 h-12 text-slate-700 mx-auto mb-4" />
        <p className="text-slate-400 font-bold uppercase text-xs tracking-widest mb-2">
          Pro zobrazení návrhů se přihlas ke Googlu
        </p>
        <p className="text-slate-600 text-xs">
          Suggestions panel čte z Anu-BattlePlan složky na Drive. Návrhy můžeš přijmout, zamítnout, odložit nebo smazat.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* HEADER */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-black text-white uppercase tracking-tight flex items-center gap-2">
            <Inbox className="w-4 h-4 text-indigo-400" /> Návrhy od Anu
          </h2>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">
            {counts.open} nových · {counts.accepted + counts.converted} přijatých · {counts.deferred} odložených · {counts.rejected} zamítnutých
          </p>
          <p className="text-[11px] text-slate-500 mt-2 max-w-2xl">
            Anu sleduje Drive návrhy: přijmi je jako task, zamítni, odlož na později nebo smaž, když už nejsou relevantní.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={loadAll}
            disabled={isLoading}
            className="px-3 py-1.5 rounded-lg bg-slate-900/50 border border-slate-800 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:bg-slate-800 hover:text-white transition-all disabled:opacity-40 flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            Obnovit
          </button>
          <div className="flex items-center gap-1 bg-slate-900/50 border border-slate-800 rounded-lg p-1">
            <Filter className="w-3 h-3 text-slate-500 ml-2" />
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-widest transition-all ${
                  filter === opt.value
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* LIST */}
      {filtered.length === 0 ? (
        <div className="p-12 text-center bg-slate-900/20 rounded-3xl border border-dashed border-slate-800">
          <Inbox className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-500 font-bold uppercase text-xs tracking-widest">
            {filter === 'open' ? 'Žádné nové návrhy' : 'Nic v této kategorii'}
          </p>
        </div>
      ) : (
        <AnimatePresence mode="popLayout">
          {filtered.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              resolution={resolutionsBySuggestion[s.id]}
              replies={repliesBySuggestion[s.id] ?? []}
              isProcessing={processingId === s.id}
              expandedTextReply={expandedTextFor === s.id}
              onExpandTextReply={(expand) => setExpandedTextFor(expand ? s.id : null)}
              onAccept={() => acceptAndCreateTask(s)}
              onReject={() => reject(s)}
              onDefer={(date) => defer(s, date)}
              onTextReply={(text) => sendTextReply(s, text)}
              onVoiceReply={(blob) => sendVoiceReply(s, blob)}
              onUpdate={(updates) => updateSuggestion(s, updates)}
              onDelete={() => deleteSuggestion(s)}
              onConfirmSameOccurrence={(occurrenceKey) => confirmSameSuggestion(s, occurrenceKey)}
              onConfirmDistinct={(occurrenceKey) => confirmDistinctSuggestion(s, occurrenceKey)}
            />
          ))}
        </AnimatePresence>
      )}

      {isLoading && filtered.length === 0 && (
        <div className="p-8 text-center text-slate-600 text-xs">
          <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin" />
          Načítám návrhy z Drive…
        </div>
      )}
    </div>
  );
}
