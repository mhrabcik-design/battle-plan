import { useState, useEffect, useMemo, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Inbox, RefreshCw, Filter } from 'lucide-react';
import {
  suggestionsSync,
  type AgentSuggestion,
  type AgentSuggestionReply,
} from '../services/suggestionsSync';
import { db } from '../db';
import { SuggestionCard } from '../components/SuggestionCard';

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
  googleAuth: { isSignedIn: boolean; accessToken: string | null };
  onAddLog: (message: string, type?: 'info' | 'error') => void;
}

export function SuggestionsPage({ googleAuth, onAddLog }: SuggestionsPageProps) {
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);
  const [repliesBySuggestion, setRepliesBySuggestion] = useState<Record<string, AgentSuggestionReply[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<FilterMode>('open');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [expandedTextFor, setExpandedTextFor] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!googleAuth.isSignedIn) return;
    setIsLoading(true);
    try {
      await suggestionsSync.init();
      if (!suggestionsSync.initialized) {
        onAddLog('SuggestionsSync: BP složka nenalezena. Otevři BP app a nech poprvé synchronizovat.', 'error');
        return;
      }
      const sugs = await suggestionsSync.fetchSuggestions();
      const replyMap: Record<string, AgentSuggestionReply[]> = {};
      for (const s of sugs) {
        const r = await suggestionsSync.fetchReplies(s.id);
        replyMap[s.id] = r.sort((a, b) => a.created_at - b.created_at);
      }
      setSuggestions(sugs);
      setRepliesBySuggestion(replyMap);
    } catch (e) {
      console.error('Load suggestions failed', e);
      onAddLog('Suggestions: Nepodařilo se načíst návrhy', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [googleAuth.isSignedIn, onAddLog]);

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 30_000);
    return () => clearInterval(t);
  }, [loadAll]);

  const counts = useMemo(() => {
    const c = { open: 0, accepted: 0, rejected: 0, deferred: 0, converted: 0 };
    for (const s of suggestions) {
      if (s.status in c) c[s.status as keyof typeof c]++;
    }
    return c;
  }, [suggestions]);

  const filtered = useMemo(() => {
    const sorted = [...suggestions].sort((a, b) => b.created_at - a.created_at);
    if (filter === 'all') return sorted;
    return sorted.filter((s) => s.status === filter);
  }, [suggestions, filter]);

  const acceptAndCreateTask = async (suggestion: AgentSuggestion) => {
    setProcessingId(suggestion.id);
    try {
      // Create task in BP
      const deadline = suggestion.context.deadline
        ? new Date(suggestion.context.deadline).toISOString().split('T')[0]
        : undefined;

      const newId = await db.tasks.add({
        title: suggestion.title,
        description: suggestion.description,
        type: 'task',
        status: 'pending',
        urgency: suggestion.context.priority === 'high' ? 3 : suggestion.context.priority === 'low' ? 1 : 2,
        date: deadline,
        deadline: deadline,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Post action reply
      await suggestionsSync.addReply({
        suggestion_id: suggestion.id,
        type: 'action',
        content: `Accepted → task #${newId}`,
        action: 'accept',
        action_data: { convert_to_task: true },
      });

      // Local optimistic update
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === suggestion.id
            ? { ...s, status: 'converted' as const, status_updated_at: Date.now() }
            : s
        )
      );

      onAddLog(`Suggestions: ✅ ${suggestion.title.slice(0, 50)} → task #${newId}`);
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
      await suggestionsSync.addReply({
        suggestion_id: suggestion.id,
        type: 'action',
        content: 'Rejected',
        action: 'reject',
      });
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === suggestion.id
            ? { ...s, status: 'rejected' as const, status_updated_at: Date.now() }
            : s
        )
      );
      onAddLog(`Suggestions: ❌ Zamítnuto: ${suggestion.title.slice(0, 50)}`);
    } catch (e) {
      console.error('Reject failed', e);
    } finally {
      setProcessingId(null);
    }
  };

  const defer = async (suggestion: AgentSuggestion, deferUntil: string) => {
    setProcessingId(suggestion.id);
    try {
      await suggestionsSync.addReply({
        suggestion_id: suggestion.id,
        type: 'action',
        content: `Deferred to ${deferUntil}`,
        action: 'defer',
        action_data: { defer_until: deferUntil },
      });
      setSuggestions((prev) =>
        prev.map((s) =>
          s.id === suggestion.id
            ? { ...s, status: 'deferred' as const, status_updated_at: Date.now() }
            : s
        )
      );
      onAddLog(`Suggestions: ⏰ Odloženo do ${deferUntil}: ${suggestion.title.slice(0, 50)}`);
    } catch (e) {
      console.error('Defer failed', e);
    } finally {
      setProcessingId(null);
    }
  };

  const sendTextReply = async (suggestion: AgentSuggestion, text: string) => {
    setProcessingId(suggestion.id);
    try {
      const result = await suggestionsSync.addReply({
        suggestion_id: suggestion.id,
        type: 'text',
        content: text,
        action: null,
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
      const result = await suggestionsSync.addReply({
        suggestion_id: suggestion.id,
        type: 'voice',
        content: '',
        voice_file_id: upload.fileId,
        action: null,
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
        onAddLog(`Suggestions: 🎙 Hlasová reakce uložena`);
      }
    } catch (e) {
      console.error('Voice reply failed', e);
      onAddLog('Suggestions: Hlasová reakce selhala', 'error');
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

  if (!googleAuth.isSignedIn) {
    return (
      <div className="p-12 text-center">
        <Inbox className="w-12 h-12 text-slate-700 mx-auto mb-4" />
        <p className="text-slate-400 font-bold uppercase text-xs tracking-widest mb-2">
          Pro zobrazení návrhů se přihlas ke Googlu
        </p>
        <p className="text-slate-600 text-xs">
          Suggestions panel čte z Anu-BattlePlan složky na Drive.
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
