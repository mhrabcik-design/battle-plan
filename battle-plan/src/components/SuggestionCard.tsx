import { useId, useState } from 'react';
import {
  Clock,
  Paperclip,
  Zap,
  Check,
  X,
  Hourglass,
  Mic,
  MessageSquare,
  CheckCircle2,
  Play,
  Pause,
  FileText,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import type { AgentSuggestion, AgentSuggestionReply } from '../services/suggestionsSync';
import {
  effectiveSuggestionStatus,
  type SuggestionResolution,
} from '../services/suggestionRegistry';
import { MonthDatePicker } from './ui/MonthDatePicker';

interface SuggestionCardProps {
  suggestion: AgentSuggestion;
  resolution?: SuggestionResolution;
  replies: AgentSuggestionReply[];
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
  onDefer: (deferUntil: string) => Promise<void>;
  onTextReply: (text: string) => Promise<void>;
  onVoiceReply: (blob: Blob) => Promise<void>;
  onUpdate: (updates: { priority?: 'high' | 'medium' | 'low'; deadline?: number | null }) => Promise<void>;
  onDelete: () => Promise<void>;
  onConfirmSameOccurrence: (occurrenceKey: string) => Promise<void>;
  onConfirmDistinct: (occurrenceKey: string) => Promise<void>;
  isProcessing: boolean;
  expandedTextReply: boolean;
  onExpandTextReply: (expand: boolean) => void;
}

const PRIORITY_STYLES = {
  high: { label: 'Vysoká priorita', dot: 'bg-red-400' },
  medium: { label: 'Střední priorita', dot: 'bg-amber-400' },
  low: { label: 'Nízká priorita', dot: 'bg-slate-400' },
};

const CATEGORY_LABELS = {
  task: 'Úkol',
  followup: 'Followup',
  preparation: 'Příprava',
  reminder: 'Připomínka',
  decision: 'Rozhodnutí',
};

const STATUS_LABELS = {
  open: 'Otevřený',
  accepted: 'Přijatý',
  rejected: 'Zamítnutý',
  deferred: 'Odložen',
  converted: 'Úkol vytvořen',
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'teď';
  if (min < 60) return `před ${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `před ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'včera';
  if (days < 7) return `před ${days}d`;
  return new Date(ts).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short' });
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

function formatDeadline(ts: number | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  if (d.getTime() < now.getTime()) {
    const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
    if (daysAgo === 0) return 'Dnes';
    return `Před ${daysAgo}d`;
  }
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function SuggestionCard({
  suggestion,
  resolution,
  replies,
  onAccept,
  onReject,
  onDefer,
  onTextReply,
  onVoiceReply,
  onUpdate,
  onDelete,
  onConfirmSameOccurrence,
  onConfirmDistinct,
  isProcessing,
  expandedTextReply,
  onExpandTextReply,
}: SuggestionCardProps) {
  const cardId = useId();
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [conversationExpanded, setConversationExpanded] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [showDeferPicker, setShowDeferPicker] = useState(false);
  const [deferDate, setDeferDate] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [priorityInput, setPriorityInput] = useState<'high' | 'medium' | 'low'>(suggestion.context.priority);
  const [deadlineInput, setDeadlineInput] = useState<string>(
    suggestion.context.deadline ? new Date(suggestion.context.deadline).toISOString().split('T')[0] : ''
  );

  const handleSavePriority = async () => {
    await onUpdate({ priority: priorityInput });
  };

  const handleSaveDeadline = async () => {
    const ts = deadlineInput ? new Date(deadlineInput).getTime() : null;
    await onUpdate({ deadline: ts });
  };

  const effectiveStatus = effectiveSuggestionStatus(suggestion, resolution);
  const isResolved = resolution?.state === 'processed'
    || resolution?.state === 'deferred'
    || effectiveStatus === 'accepted'
    || effectiveStatus === 'rejected'
    || effectiveStatus === 'converted';
  const requiresDuplicateDecision = resolution?.state === 'possible-duplicate'
    && Boolean(resolution.matchedOccurrenceKey);

  const handleTextSubmit = async () => {
    if (!textValue.trim() || isProcessing) return;
    await onTextReply(textValue.trim());
    setTextValue('');
    onExpandTextReply(false);
  };

  const handleDeferSubmit = async () => {
    if (!deferDate || isProcessing) return;
    await onDefer(deferDate);
    setShowDeferPicker(false);
    setDeferDate('');
  };

  const startVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        setRecorder(null);
        await onVoiceReply(blob);
      };
      rec.start();
      setRecorder(rec);
      setIsRecording(true);
    } catch (e) {
      console.error('Voice recording failed', e);
      alert('Nelze přistoupit k mikrofonu. Zkontroluj oprávnění.');
    }
  };

  const stopVoice = () => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }
  };

  const playVoice = (replyId: string) => {
    if (playingVoiceId === replyId && audioElement) {
      audioElement.pause();
      setPlayingVoiceId(null);
      return;
    }
    if (audioElement) audioElement.pause();
    const audio = new Audio(`https://www.googleapis.com/drive/v3/files/${replies.find((r) => r.id === replyId)?.voice_file_id}?alt=media`);
    audio.onended = () => setPlayingVoiceId(null);
    audio.play().catch((e) => console.error('Play failed', e));
    setAudioElement(audio);
    setPlayingVoiceId(replyId);
  };

  const priority = PRIORITY_STYLES[suggestion.context.priority] ?? PRIORITY_STYLES.medium;
  const category = CATEGORY_LABELS[suggestion.category] ?? CATEGORY_LABELS.task;
  const status = STATUS_LABELS[effectiveStatus] ?? STATUS_LABELS.open;
  const deadlineText = formatDeadline(suggestion.context.deadline);
  const description = suggestion.description ?? '';
  const hasLongDescription = description.length > 220 || description.split('\n').length > 3;

  return (
    <article
      aria-labelledby={`${cardId}-title`}
      aria-busy={isProcessing}
      className="suggestion-card min-w-0 rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-1)] p-4 [overflow-wrap:anywhere] sm:p-5"
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--text-muted)]">
        <span data-category={suggestion.category} className="suggestion-chip rounded-md px-2 py-1 font-medium">{category}</span>
        <span data-priority={suggestion.context.priority} className="suggestion-chip inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${priority.dot}`} />
          {priority.label}
        </span>
        {effectiveStatus !== 'open' && (
          <span data-status={effectiveStatus} className="suggestion-chip rounded-md px-2 py-1 font-medium">
            {status}
          </span>
        )}
        <time dateTime={new Date(suggestion.created_at).toJSON() ?? undefined} className="ml-auto shrink-0">
          {formatTimeAgo(suggestion.created_at)}
        </time>
      </div>

      <h3 id={`${cardId}-title`} className="mb-2 text-lg font-semibold leading-snug text-[var(--text-primary)]">
        {suggestion.title}
      </h3>
      {description && (
        <div className="mb-4">
          <p
            id={`${cardId}-description`}
            className={`whitespace-pre-line text-sm leading-relaxed text-[var(--text-secondary)] ${hasLongDescription && !descriptionExpanded ? 'line-clamp-3' : ''}`}
          >
            {description}
          </p>
          {hasLongDescription && (
            <button
              type="button"
              aria-expanded={descriptionExpanded}
              aria-controls={`${cardId}-description`}
              onClick={() => setDescriptionExpanded((expanded) => !expanded)}
              className="mt-1 min-h-11 rounded-lg px-1 text-sm font-medium text-[var(--text-secondary)] underline decoration-[var(--control-border)] underline-offset-4 hover:decoration-current"
            >
              {descriptionExpanded ? 'Sbalit popis' : 'Zobrazit celý popis'}
            </button>
          )}
        </div>
      )}

      {resolution?.state === 'processed' && suggestion.status === 'open' && (
        <div role="status" data-status={effectiveStatus} className="suggestion-chip mb-4 rounded-xl border border-[var(--surface-border)] px-3 py-3 text-sm">
          <span className="font-semibold">Již zpracováno</span>
          <span> · stejná událost byla dříve {resolution.decision?.kind === 'rejected' || resolution.decision?.kind === 'dismissed' ? 'zamítnuta' : 'schválena'}.</span>
        </div>
      )}

      {requiresDuplicateDecision && (
        <div role="alert" className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2 text-[var(--text-primary)]">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Možná duplicita</p>
              <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                Podobá se dříve zpracované události „{resolution.matchedTitle ?? 'bez názvu'}“. Rozhodni, zda jde o totéž.
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onConfirmSameOccurrence(resolution.matchedOccurrenceKey!)}
              disabled={isProcessing}
              className="min-h-11 rounded-lg border border-amber-500/40 px-3 text-sm font-semibold text-[var(--text-primary)] hover:bg-amber-500/10 disabled:opacity-40"
            >
              Je to stejné
            </button>
            <button
              type="button"
              onClick={() => onConfirmDistinct(resolution.matchedOccurrenceKey!)}
              disabled={isProcessing}
              className="min-h-11 rounded-lg border border-[var(--control-border)] bg-[var(--surface-1)] px-3 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-40"
            >
              Je to nové
            </button>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
        {deadlineText && (
          <span className="flex items-center gap-1.5 rounded-lg bg-[var(--surface-2)] px-3 py-2">
            <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> {deadlineText}
          </span>
        )}
        {!isResolved && (
          <>
            <div role="group" aria-label="Termín návrhu" className="flex min-w-0 flex-wrap items-center rounded-lg border border-[var(--surface-border)]">
              <MonthDatePicker
                value={deadlineInput}
                onChange={setDeadlineInput}
                label="Vybrat termín návrhu"
                disabled={isProcessing}
                allowClear
                className="min-h-11 max-w-48 border-0 bg-transparent px-3 hover:bg-[var(--surface-2)]"
              />
              {deadlineInput !== (suggestion.context.deadline ? new Date(suggestion.context.deadline).toISOString().split('T')[0] : '') && (
                <button
                  type="button"
                  onClick={handleSaveDeadline}
                  disabled={isProcessing}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--text-primary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                  aria-label="Uložit termín návrhu"
                >
                  <Check aria-hidden="true" className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex min-w-0 items-center rounded-lg border border-[var(--surface-border)] pl-3">
              <Zap aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <select
                aria-label="Priorita návrhu"
                value={priorityInput}
                onChange={(e) => setPriorityInput(e.target.value as 'high' | 'medium' | 'low')}
                disabled={isProcessing}
                className="min-h-11 min-w-0 cursor-pointer rounded-lg border-none bg-[var(--surface-1)] pl-2 pr-3 text-xs text-[var(--text-secondary)] disabled:opacity-50"
              >
                <option value="high">Vysoká</option>
                <option value="medium">Střední</option>
                <option value="low">Nízká</option>
              </select>
              {priorityInput !== suggestion.context.priority && (
                <button
                  type="button"
                  onClick={handleSavePriority}
                  disabled={isProcessing}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--text-primary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                  aria-label="Uložit prioritu"
                >
                  <Check aria-hidden="true" className="h-4 w-4" />
                </button>
              )}
            </div>
          </>
        )}
        {suggestion.context.related_task_ids.length > 0 && (
          <span className="flex min-w-0 items-start gap-1.5 px-1 py-2">
            <Paperclip aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Úkoly #{suggestion.context.related_task_ids.join(', #')}</span>
          </span>
        )}
        {suggestion.source && (
          <span className="flex min-w-0 items-start gap-1.5 px-1 py-2">
            <FileText aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{suggestion.source}</span>
          </span>
        )}
      </div>

      {replies.length > 0 && (
        <details
          onToggle={(event) => setConversationExpanded(event.currentTarget.open)}
          className="mb-4 rounded-xl border border-[var(--surface-border)] bg-[var(--surface-bg)]"
        >
          <summary className="min-h-11 cursor-pointer rounded-xl px-3 py-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]">
            <MessageSquare aria-hidden="true" className="mx-1 inline-block h-3.5 w-3.5" />
            Konverzace ({replies.length})
          </summary>
          {conversationExpanded && (
            <div className="space-y-3 border-t border-[var(--surface-border)] p-3">
              {replies.map((reply) => (
                <div key={reply.id} className="text-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <span className="font-medium">{reply.type === 'action' ? 'Akce' : 'Ty'}</span>
                    <time dateTime={new Date(reply.created_at).toJSON() ?? undefined}>{formatTimestamp(reply.created_at)}</time>
                  </div>
                  {reply.type === 'voice' && reply.voice_file_id ? (
                    <button
                      type="button"
                      onClick={() => playVoice(reply.id)}
                      className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--control-border)] px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                    >
                      {playingVoiceId === reply.id ? <Pause aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
                      {playingVoiceId === reply.id ? 'Pozastavit nahrávku' : 'Přehrát nahrávku'}
                    </button>
                  ) : reply.type === 'action' ? (
                    <p className="text-[var(--text-secondary)]">
                      {reply.action === 'accept' && 'Přijato'}
                      {reply.action === 'reject' && 'Zamítnuto'}
                      {reply.action === 'defer' && `Odloženo do ${reply.action_data?.defer_until || '?'}`}
                    </p>
                  ) : (
                    <p className="whitespace-pre-line leading-relaxed text-[var(--text-secondary)]">{reply.content}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </details>
      )}

      {expandedTextReply && !isResolved && (
        <div id={`${cardId}-reply`} className="mb-4 space-y-3 rounded-xl border border-[var(--surface-border)] bg-[var(--surface-bg)] p-3">
          <label htmlFor={`${cardId}-reply-input`} className="block text-sm font-medium text-[var(--text-primary)]">Odpověď pro Anu</label>
          <textarea
            id={`${cardId}-reply-input`}
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            placeholder="Napiš odpověď…"
            rows={3}
            className="w-full resize-y rounded-lg border border-[var(--control-border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { onExpandTextReply(false); setTextValue(''); }}
              className="min-h-11 rounded-lg px-3 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              Zrušit
            </button>
            <button
              type="button"
              onClick={handleTextSubmit}
              disabled={!textValue.trim() || isProcessing}
              className="flex min-h-11 items-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check aria-hidden="true" className="h-4 w-4" /> Odeslat
            </button>
          </div>
        </div>
      )}

      {showDeferPicker && !isResolved && (
        <div id={`${cardId}-defer`} className="mb-4 space-y-3 rounded-xl border border-[var(--surface-border)] bg-[var(--surface-bg)] p-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">Odložit do</p>
          <MonthDatePicker
            value={deferDate}
            onChange={setDeferDate}
            label="Odložit návrh do"
            disabled={isProcessing}
            className="min-h-11 w-full justify-start"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setShowDeferPicker(false); setDeferDate(''); }}
              className="min-h-11 rounded-lg px-3 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              Zrušit
            </button>
            <button
              type="button"
              onClick={handleDeferSubmit}
              disabled={!deferDate || isProcessing}
              className="flex min-h-11 items-center gap-2 rounded-lg bg-amber-700 px-4 text-sm font-semibold text-on-accent hover:bg-amber-800 disabled:opacity-40"
            >
              <Hourglass aria-hidden="true" className="h-4 w-4" /> Odložit
            </button>
          </div>
        </div>
      )}

      {!isResolved && !requiresDuplicateDecision && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--surface-border)] pt-4">
          <button
            type="button"
            onClick={onAccept}
            disabled={isProcessing}
            aria-label="Přijmout a vytvořit úkol"
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40 sm:w-auto"
          >
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" /> Vytvořit úkol
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={isProcessing}
            data-status="rejected"
            className="suggestion-action-soft flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium disabled:opacity-40"
          >
            <X aria-hidden="true" className="h-4 w-4" /> Zamítnout
          </button>
          <button
            type="button"
            onClick={() => setShowDeferPicker((open) => !open)}
            disabled={isProcessing}
            aria-expanded={showDeferPicker}
            aria-controls={showDeferPicker ? `${cardId}-defer` : undefined}
            data-status="deferred"
            className="suggestion-action-soft flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium disabled:opacity-40"
          >
            <Hourglass aria-hidden="true" className="h-4 w-4" /> Odložit
          </button>
          <button
            type="button"
            onClick={() => onExpandTextReply(!expandedTextReply)}
            disabled={isProcessing}
            aria-expanded={expandedTextReply}
            aria-controls={expandedTextReply ? `${cardId}-reply` : undefined}
            data-category="task"
            className="suggestion-action-soft flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium disabled:opacity-40 sm:ml-auto"
          >
            <MessageSquare aria-hidden="true" className="h-4 w-4" /> Odpovědět
          </button>
          <button
            type="button"
            onClick={isRecording ? stopVoice : startVoice}
            disabled={isProcessing}
            aria-pressed={isRecording}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-[var(--text-secondary)] disabled:opacity-40 ${isRecording ? 'bg-red-500/15' : 'hover:bg-[var(--surface-2)]'}`}
          >
            <Mic aria-hidden="true" className="h-4 w-4" />
            {isRecording ? 'Ukončit nahrávání' : 'Hlas'}
          </button>
          <button
            type="button"
            onClick={async () => {
              if (window.confirm('Smazat návrh?')) await onDelete();
            }}
            disabled={isProcessing}
            aria-label="Smazat návrh"
            title="Smazat návrh"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--text-muted)] hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      )}

      {isResolved && effectiveStatus === 'converted' && (
        <div data-status="converted" className="suggestion-color-text flex items-center gap-2 text-sm">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
          Úkol je vytvořený v Plánu.
        </div>
      )}
    </article>
  );
}
