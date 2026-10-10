import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Inbox, RefreshCw, CheckCheck, AlertCircle, ArrowDown } from 'lucide-react';
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
import { captureGoogleAccountSession, type GoogleAccountSession } from '../services/googleAccountSession';
import { googleService } from '../services/googleService';
import { resolveSuggestionsSnapshot } from '../utils/suggestionReplies';
import {
  describeSuggestionPartialSync,
  type SuggestionLegacyMirrors,
} from '../utils/suggestionSyncDiagnostics';

type FilterMode = 'all' | 'open' | 'accepted' | 'rejected' | 'deferred' | 'converted';
const PAGE_SIZE = 20;

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
  const hasUsableAuthValue = hasUsableAuth(googleAuth);
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);
  const [repliesBySuggestion, setRepliesBySuggestion] = useState<Record<string, AgentSuggestionReply[]>>({});
  const [resolutionsBySuggestion, setResolutionsBySuggestion] = useState<Record<string, SuggestionResolution>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('open');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [expandedTextFor, setExpandedTextFor] = useState<string | null>(null);
  const loadInFlightRef = useRef<GoogleAccountSession | null>(null);
  const accountId = googleService.getAccountId();
  const authGeneration = googleService.getAuthGeneration();
  const accessToken = googleAuth.accessToken;
  const pageSession = useMemo(() => {
    const session = captureGoogleAccountSession();
    return {
      ...session,
      isCurrent: () => session.isCurrent()
        && googleService.getAuthStatus().accessToken === accessToken
        && googleService.getAuthGeneration() === authGeneration
        && googleService.getAccountId() === accountId,
    };
  }, [accessToken, authGeneration, accountId]);
  const previousPageSessionRef = useRef(pageSession);
  const previousAccountRef = useRef(accountId);
  const loadedSessionRef = useRef<GoogleAccountSession | null>(null);
  const activePageSessionRef = useRef<GoogleAccountSession | null>(null);
  const isPageActive = useCallback(
    () => pageSession.isCurrent() && activePageSessionRef.current === pageSession,
    [pageSession],
  );

  const resolveAll = useCallback(async (values: readonly AgentSuggestion[]) => {
    const resolutions = await suggestionRegistry.resolveMany(values);
    const entries = values.map((suggestion, index) => [suggestion.id, resolutions[index]] as const);
    return Object.fromEntries(entries);
  }, []);

  const refreshResolution = useCallback(async (suggestion: AgentSuggestion) => {
    if (!isPageActive()) return;
    const resolution = await suggestionRegistry.resolve(suggestion);
    if (!isPageActive()) return;
    setResolutionsBySuggestion((previous) => ({ ...previous, [suggestion.id]: resolution }));
  }, [isPageActive]);

  const reportPartialSync = (
    action: string,
    registryResult: SuggestionRegistryPublishResult,
    mirrors: SuggestionLegacyMirrors,
  ) => {
    const message = describeSuggestionPartialSync(action, registryResult, mirrors);
    if (message) onAddLog(message, 'error');
  };

  const loadAll = useCallback(async () => {
    if (!isPageActive() || !hasUsableAuthValue) return;
    if (loadInFlightRef.current === pageSession) return;
    const reservation = pageSession;
    loadInFlightRef.current = reservation;
    const isActive = () => isPageActive() && loadInFlightRef.current === reservation;
    setIsLoading(true);
    setLoadError(null);
    try {
      await suggestionsSync.init();
      if (!isActive()) return;
      if (!suggestionsSync.initialized) {
        setLoadError('Složka s návrhy zatím není dostupná. Nech dokončit první synchronizaci s Google Drive a zkus to znovu.');
        onAddLog('SuggestionsSync: BP složka nenalezena. Otevři BP app a nech poprvé synchronizovat.', 'error');
        return;
      }
      const [suggestionsResult, repliesResult, registryFetch] = await Promise.all([
        suggestionsSync.fetchSuggestionsDetailed(),
        suggestionsSync.fetchRepliesDetailed(),
        suggestionRegistrySync.fetchAndMerge(),
      ]);
      if (!isActive()) return;

      if (suggestionsResult.kind === 'store-unavailable' || suggestionsResult.kind === 'error') {
        const message = suggestionsResult.kind === 'error'
          ? suggestionsResult.message
          : suggestionsResult.status.message;
        setLoadError(`Návrhy se nepodařilo načíst. ${message}`);
        onAddLog(`Suggestions: Návrhy se nepodařilo načíst (${message})`, 'error');
        return;
      }
      const sugs = suggestionsResult.suggestions;

      const snapshot = resolveSuggestionsSnapshot(sugs, repliesResult);
      if (snapshot.kind === 'preserve') {
        setLoadError('Odpovědi se nepodařilo načíst. Zobrazuji poslední úplný stav; zkus obnovení.');
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
        setLoadError('Nepodařilo se ověřit předchozí rozhodnutí. Návrhy zpřístupním po úspěšném obnovení, aby nevznikly duplicitní úkoly.');
        onAddLog(`Suggestions: Návrhy jsou pozastavené, dokud se nenačte registr rozhodnutí (${message})`, 'error');
        return;
      }
      const replies = Object.values(snapshot.repliesBySuggestion).flat();
      await suggestionRegistry.ingestLegacy(sugs, replies, pageSession.assertCurrent);
      if (!isActive()) return;
      const resolutions = await resolveAll(sugs);
      if (!isActive()) return;
      setResolutionsBySuggestion(resolutions);
      loadedSessionRef.current = reservation;
      setSuggestions(sugs);
      setRepliesBySuggestion(snapshot.repliesBySuggestion);
      const registryPublish = await suggestionRegistrySync.publishPending();
      if (!isActive()) return;
      if (registryPublish.kind === 'error') {
        console.warn('Suggestion decision registry publish failed', registryPublish.message);
      }
    } catch (e) {
      if (!isActive()) return;
      setLoadError('Návrhy se nepodařilo načíst. Zkontroluj připojení a zkus obnovení.');
      console.error('Load suggestions failed', e);
      onAddLog('Suggestions: Nepodařilo se načíst návrhy', 'error');
    } finally {
      if (loadInFlightRef.current === reservation) {
        loadInFlightRef.current = null;
        if (isPageActive()) setIsLoading(false);
      }
    }
  }, [hasUsableAuthValue, onAddLog, resolveAll, isPageActive, pageSession]);

  useEffect(() => {
    activePageSessionRef.current = pageSession;
    queueMicrotask(() => {
      if (!isPageActive()) return;
      if (previousPageSessionRef.current !== pageSession) {
        previousPageSessionRef.current = pageSession;
        setProcessingId(null);
      }
      if (previousAccountRef.current !== accountId) {
        previousAccountRef.current = accountId;
        setSuggestions([]);
        setRepliesBySuggestion({});
        setResolutionsBySuggestion({});
        setProcessingId(null);
        setExpandedTextFor(null);
        setLoadError(null);
      }
      loadAll();
    });
    const t = setInterval(loadAll, 30_000);
    return () => {
      if (activePageSessionRef.current === pageSession) activePageSessionRef.current = null;
      clearInterval(t);
    };
  }, [loadAll, pageSession, isPageActive, accountId]);

  const counts = useMemo(() => {
    const c = { open: 0, accepted: 0, rejected: 0, deferred: 0, converted: 0 };
    for (const s of suggestions) {
      const status = effectiveSuggestionStatus(s, resolutionsBySuggestion[s.id]);
      if (status in c) c[status as keyof typeof c]++;
    }
    return c;
  }, [suggestions, resolutionsBySuggestion]);

  const sorted = useMemo(
    () => [...suggestions].sort((a, b) => b.created_at - a.created_at),
    [suggestions],
  );
  const filtered = useMemo(
    () => filter === 'all' ? sorted : sorted.filter((s) => effectiveSuggestionStatus(s, resolutionsBySuggestion[s.id]) === filter),
    [sorted, resolutionsBySuggestion, filter],
  );
  const [previousResults, setPreviousResults] = useState({ filter, items: filtered });
  if (previousResults.items !== filtered || previousResults.filter !== filter) {
    // Adjust before committing the render so refresh cannot unmount a card's draft.
    if (previousResults.filter === filter) {
      const shownIds = new Set(previousResults.items.slice(0, visibleCount).map((s) => s.id));
      for (let index = filtered.length - 1; index >= visibleCount; index--) {
        if (shownIds.has(filtered[index].id)) {
          setVisibleCount(index + 1);
          break;
        }
      }
    }
    setPreviousResults({ filter, items: filtered });
  }
  const visibleSuggestions = filtered.slice(0, visibleCount);

  const acceptAndCreateTask = async (suggestion: AgentSuggestion) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
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
        startTime: deadline ? '15:00' : undefined,
        createdAt: now,
        updatedAt: now,
      }, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;

      const retryLabel = conversion.outcome === 'existing' ? ' (už existoval)' : '';
      onAddLog(`Suggestions: ✅ ${suggestion.title.slice(0, 50)} → task #${taskId}${retryLabel}`);
    } catch (e) {
      if (!isPageActive()) return;
      console.error('Accept failed', e);
      onAddLog(`Suggestions: Chyba při vytváření tasku: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  const reject = async (suggestion: AgentSuggestion) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, { kind: 'rejected' }, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
      onAddLog(`Suggestions: ❌ Zamítnuto: ${suggestion.title.slice(0, 50)}`);
    } catch (e) {
      if (!isPageActive()) return;
      console.error('Reject failed', e);
      onAddLog('Suggestions: Zamítnutí se nepodařilo uložit', 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  const deleteSuggestion = async (suggestion: AgentSuggestion) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, { kind: 'dismissed' }, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
      const registryResult = await suggestionRegistrySync.publishPending();
      if (!isPageActive()) return;
      const result = await suggestionsSync.deleteSuggestion(suggestion.id);
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
      console.error('Delete suggestion failed', e);
      onAddLog('Suggestions: Smazat návrh selhalo', 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

   const defer = async (suggestion: AgentSuggestion, deferUntil: string) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, {
        kind: 'deferred',
        deferUntil: new Date(`${deferUntil}T00:00:00`).getTime(),
      }, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
      onAddLog(`Suggestions: ⏰ Odloženo do ${deferUntil}: ${suggestion.title.slice(0, 50)}`);
    } catch (e) {
      if (!isPageActive()) return;
      console.error('Defer failed', e);
      onAddLog('Suggestions: Odložení se nepodařilo uložit', 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  const sendTextReply = async (suggestion: AgentSuggestion, text: string) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.recordDecision(suggestion, { kind: 'commented', comment: text }, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
      const [registryResult, result] = await Promise.all([
        suggestionRegistrySync.publishPending(),
        suggestionsSync.addReply({
          suggestion_id: suggestion.id,
          type: 'text',
          content: text,
          action: null,
        }),
      ]);
      if (!isPageActive()) return;
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
        if (!isPageActive()) return;
        onAddLog(`Suggestions: 💬 Text reply odeslán`);
      }
    } catch (e) {
      if (!isPageActive()) return;
      console.error('Text reply failed', e);
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  const sendVoiceReply = async (suggestion: AgentSuggestion, blob: Blob) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      const upload = await suggestionsSync.uploadVoiceReply(suggestion.id, blob);
      if (!isPageActive()) return;
      if (!upload.success || !upload.fileId) {
        onAddLog('Suggestions: Nahrávání hlasu selhalo', 'error');
        return;
      }
      await suggestionRegistry.recordDecision(suggestion, { kind: 'commented', comment: 'Hlasová reakce' }, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
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
        if (!isPageActive()) return;
        onAddLog(`Suggestions: 🎙 Hlasová reakce uložena`);
      }
    } catch (e) {
      if (!isPageActive()) return;
      console.error('Voice reply failed', e);
      onAddLog('Suggestions: Hlasová reakce selhala', 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  const confirmSameSuggestion = async (suggestion: AgentSuggestion, targetOccurrenceKey: string) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.confirmSameOccurrence(suggestion, targetOccurrenceKey, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
      const registryResult = await suggestionRegistrySync.publishPending();
      if (!isPageActive()) return;
      reportPartialSync('sloučení návrhů bylo zaznamenáno', registryResult, {});
      await refreshResolution(suggestion);
      if (!isPageActive()) return;
      onAddLog(`Suggestions: Duplicitní návrh „${suggestion.title.slice(0, 50)}“ byl sloučen.`);
    } catch (e) {
      if (!isPageActive()) return;
      console.error('Confirm duplicate suggestion failed', e);
      onAddLog('Suggestions: Sloučení návrhů se nepodařilo', 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  const confirmDistinctSuggestion = async (suggestion: AgentSuggestion, targetOccurrenceKey: string) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      await suggestionRegistry.confirmDistinctSubjects(suggestion, targetOccurrenceKey, undefined, pageSession.assertCurrent);
      if (!isPageActive()) return;
      const registryResult = await suggestionRegistrySync.publishPending();
      if (!isPageActive()) return;
      reportPartialSync('nová samostatná událost byla zaznamenána', registryResult, {});
      await refreshResolution(suggestion);
      if (!isPageActive()) return;
      onAddLog(`Suggestions: „${suggestion.title.slice(0, 50)}“ zůstává jako nový návrh.`);
    } catch (e) {
      if (!isPageActive()) return;
      console.error('Confirm distinct suggestion failed', e);
      onAddLog('Suggestions: Rozlišení návrhů se nepodařilo', 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  const updateSuggestion = async (
    suggestion: AgentSuggestion,
    updates: { priority?: 'high' | 'medium' | 'low'; deadline?: number | null }
  ) => {
    if (!isPageActive() || !loadedSessionRef.current?.isCurrent()) return;
    setProcessingId(suggestion.id);
    try {
      const ok = await suggestionsSync.updateSuggestion(suggestion.id, updates);
      if (!isPageActive()) return;
      if (!ok.success) {
        onAddLog('Suggestions: Úprava selhala', 'error');
        return;
      }
      // Reflect the saved edit before waiting for its audit reply.
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
      if (!isPageActive()) return;
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
      if (!isPageActive()) return;
      console.error('Update suggestion failed', e);
      onAddLog('Suggestions: Úprava selhala', 'error');
    } finally {
      if (isPageActive()) setProcessingId(null);
    }
  };

  if (!hasUsableAuth(googleAuth)) {
    return (
      <div className="rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-1)] px-6 py-14 text-center">
        <Inbox className="mx-auto mb-4 h-10 w-10 text-indigo-400" aria-hidden="true" />
        <h2 className="mb-2 text-lg font-semibold text-[var(--text-primary)]">
          Pro zobrazení návrhů se přihlas ke Googlu
        </h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
          Připojení najdeš v Nastavení. Návrhy od Anu pak můžeš převést na úkoly, odložit nebo zamítnout.
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Návrhy od Anu" className="suggestions-colors min-w-0 space-y-5">
      {/* HEADER */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)]">
            <Inbox className="h-4 w-4 text-indigo-400" aria-hidden="true" /> OD ANU
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-3xl">
            Návrhy
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
            Vyber, co má smysl. Z návrhu vytvoř úkol, nebo ho odlož na vhodnější chvíli.
          </p>
        </div>
          <button
            type="button"
            onClick={loadAll}
            disabled={isLoading}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-[var(--control-border)] bg-[var(--surface-1)] px-3 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-60"
          >
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${isLoading ? 'motion-safe:animate-spin' : ''}`} />
            Obnovit
          </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-[var(--surface-border)] py-3 text-sm text-[var(--text-secondary)]">
        <span data-status="open" className="suggestion-color-text"><strong className="font-semibold">{counts.open}</strong> k rozhodnutí</span>
        <span data-status="accepted" className="suggestion-color-text inline-flex items-center gap-1.5"><CheckCheck aria-hidden="true" className="h-4 w-4" />{counts.accepted + counts.converted} přijatých</span>
        <span data-status="deferred" className="suggestion-color-text">{counts.deferred} odložených</span>
      </div>

      <div role="group" aria-label="Filtrovat návrhy podle stavu" className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap">
            {FILTER_OPTIONS.map((opt) => (
              <button
                type="button"
                key={opt.value}
                aria-pressed={filter === opt.value}
                onClick={() => {
                  if (filter === opt.value) return;
                  setFilter(opt.value);
                  setVisibleCount(PAGE_SIZE);
                  setExpandedTextFor(null);
                }}
                className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-medium transition-colors sm:gap-2 sm:px-3 ${
                  filter === opt.value
                    ? 'bg-indigo-600 font-semibold text-white'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                {opt.label}
                <span data-status={opt.value} className={`rounded-md px-1.5 py-0.5 text-xs tabular-nums ${filter === opt.value ? 'bg-white/15' : 'suggestion-chip'}`}>
                  {opt.value === 'all' ? suggestions.length : counts[opt.value]}
                </span>
              </button>
            ))}
      </div>

      {loadError && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-[var(--text-primary)]">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Obnovení se nepodařilo</p>
            <p className="mt-1 break-words leading-relaxed text-[var(--text-secondary)]">{loadError}</p>
            <button type="button" onClick={loadAll} disabled={isLoading} className="mt-2 min-h-11 rounded-lg px-2 font-semibold underline underline-offset-4 disabled:opacity-50">Zkusit znovu</button>
          </div>
        </div>
      )}

      {/* LIST */}
      {isLoading && suggestions.length === 0 ? (
        <div role="status" className="rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-1)] p-10 text-center text-sm text-[var(--text-secondary)]">
          <RefreshCw aria-hidden="true" className="mx-auto mb-3 h-6 w-6 text-indigo-400 motion-safe:animate-spin" />
          Načítám návrhy a ověřuji předchozí rozhodnutí…
        </div>
      ) : filtered.length === 0 ? (
        !loadError && <div className="rounded-2xl border border-dashed border-[var(--control-border)] px-6 py-12 text-center">
          <CheckCheck aria-hidden="true" className="mx-auto mb-3 h-9 w-9 text-[var(--text-muted)]" />
          <h3 className="text-base font-semibold text-[var(--text-primary)]">{filter === 'open' ? 'Vše vyřízeno' : 'Žádné návrhy v tomto filtru'}</h3>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">{filter === 'open' ? 'Až Anu připraví nové návrhy, najdeš je tady.' : 'Zkus jiný stav nebo zobraz všechny návrhy.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p role="status" className="text-xs text-[var(--text-muted)]">
            Zobrazeno {visibleSuggestions.length} z {filtered.length} · od nejnovějších{isLoading ? ' · Obnovuji…' : ''}
          </p>
          {visibleSuggestions.map((s) => (
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
          {visibleSuggestions.length < filtered.length && (
            <div className="flex justify-center pt-2">
              <button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--control-border)] bg-[var(--surface-1)] px-5 py-2 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-2)]">
                <ArrowDown aria-hidden="true" className="h-4 w-4" /> Zobrazit dalších {Math.min(PAGE_SIZE, filtered.length - visibleSuggestions.length)}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
