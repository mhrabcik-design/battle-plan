import { useState } from 'react';
import { motion } from 'framer-motion';
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
} from 'lucide-react';
import type { AgentSuggestion, AgentSuggestionReply } from '../services/suggestionsSync';

interface SuggestionCardProps {
  suggestion: AgentSuggestion;
  replies: AgentSuggestionReply[];
  onAccept: (convertToTask: boolean) => Promise<void>;
  onReject: () => Promise<void>;
  onDefer: (deferUntil: string) => Promise<void>;
  onTextReply: (text: string) => Promise<void>;
  onVoiceReply: (blob: Blob) => Promise<void>;
  onUpdate: (updates: { priority?: 'high' | 'medium' | 'low'; deadline?: number | null }) => Promise<void>;
  isProcessing: boolean;
  expandedTextReply: boolean;
  onExpandTextReply: (expand: boolean) => void;
}

const PRIORITY_STYLES = {
  high: { label: 'Vysoká', className: 'bg-red-500/10 text-red-400 border-red-500/20' },
  medium: { label: 'Střední', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  low: { label: 'Nízká', className: 'bg-slate-700/30 text-slate-400 border-slate-600/30' },
};

const CATEGORY_STYLES = {
  task: { label: 'Úkol', className: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20' },
  followup: { label: 'Followup', className: 'bg-violet-500/10 text-violet-300 border-violet-500/20' },
  preparation: { label: 'Příprava', className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
  reminder: { label: 'Připomínka', className: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20' },
  decision: { label: 'Rozhodnutí', className: 'bg-pink-500/10 text-pink-300 border-pink-500/20' },
};

const STATUS_STYLES = {
  open: { label: 'Otevřený', className: 'bg-slate-800 text-slate-400' },
  accepted: { label: 'Přijatý', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  rejected: { label: 'Zamítnutý', className: 'bg-red-500/10 text-red-400 border-red-500/20' },
  deferred: { label: 'Odložen', className: 'bg-amber-600/15 text-amber-300 border-amber-600/25' },
  converted: { label: 'Hotovo', className: 'bg-emerald-600/15 text-emerald-300 border-emerald-600/25' },
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
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  if (sameDay) return `dnes ${d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`;
  if (isTomorrow) return `zítra ${d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function SuggestionCard({
  suggestion,
  replies,
  onAccept,
  onReject,
  onDefer,
  onTextReply,
  onVoiceReply,
  onUpdate,
  isProcessing,
  expandedTextReply,
  onExpandTextReply,
}: SuggestionCardProps) {
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

  const isResolved = suggestion.status === 'accepted' || suggestion.status === 'rejected' || suggestion.status === 'converted';

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
  const category = CATEGORY_STYLES[suggestion.category] ?? CATEGORY_STYLES.task;
  const status = STATUS_STYLES[suggestion.status] ?? STATUS_STYLES.open;
  const deadlineText = formatDeadline(suggestion.context.deadline);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`p-5 rounded-2xl border bg-slate-900/40 transition-all ${
        isResolved
          ? 'border-emerald-900/40 bg-emerald-950/20 opacity-70'
          : 'border-slate-800 hover:border-slate-700'
      }`}
    >
      {/* HEADER: priority + category + status + time */}
      <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${priority.className}`}>
            <Zap className="w-3 h-3 inline-block mr-1" />
            {priority.label}
          </span>
          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${category.className}`}>
            {category.label}
          </span>
          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest border ${status.className}`}>
            {status.label}
          </span>
        </div>
        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider shrink-0">
          {formatTimeAgo(suggestion.created_at)}
        </span>
      </div>

      {/* TITLE + DESCRIPTION */}
      <h3 className={`text-base font-black text-white mb-2 ${isResolved ? 'opacity-70' : ''}`}>
        {suggestion.title}
      </h3>
      {suggestion.description && (
        <p className="text-sm text-slate-400 leading-relaxed mb-3">
          {suggestion.description}
        </p>
      )}

      {/* META: deadline, related, source */}
      <div className="flex flex-wrap gap-2 mb-3 text-[11px]">
        {deadlineText && (
          <span className="px-2 py-1 rounded-md bg-slate-800/50 text-slate-400 font-mono flex items-center gap-1">
            <Clock className="w-3 h-3" /> {deadlineText}
          </span>
        )}
        {!isResolved && (
          <>
            <span className="px-2 py-1 rounded-md bg-slate-800/50 text-slate-400 font-mono flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <input
                type="date"
                value={deadlineInput}
                onChange={(e) => setDeadlineInput(e.target.value)}
                disabled={isProcessing}
                className="bg-transparent border-none outline-none text-slate-300 font-mono text-[11px] w-[110px] disabled:opacity-50"
                title="Upravit deadline"
              />
              {deadlineInput !== (suggestion.context.deadline ? new Date(suggestion.context.deadline).toISOString().split('T')[0] : '') && (
                <button
                  onClick={handleSaveDeadline}
                  disabled={isProcessing}
                  className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                  title="Uložit deadline"
                >✓</button>
              )}
            </span>
            <span className="px-2 py-1 rounded-md bg-slate-800/50 text-slate-400 font-mono flex items-center gap-1.5">
              <Zap className="w-3 h-3" />
              <select
                value={priorityInput}
                onChange={(e) => setPriorityInput(e.target.value as 'high' | 'medium' | 'low')}
                disabled={isProcessing}
                className="bg-transparent border-none outline-none text-slate-300 font-mono text-[11px] disabled:opacity-50 cursor-pointer"
                title="Změnit prioritu"
              >
                <option value="high">Vysoká</option>
                <option value="medium">Střední</option>
                <option value="low">Nízká</option>
              </select>
              {priorityInput !== suggestion.context.priority && (
                <button
                  onClick={handleSavePriority}
                  disabled={isProcessing}
                  className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                  title="Uložit prioritu"
                >✓</button>
              )}
            </span>
          </>
        )}
        {suggestion.context.related_task_ids.length > 0 && (
          <span className="px-2 py-1 rounded-md bg-slate-800/50 text-slate-400 font-mono flex items-center gap-1">
            <Paperclip className="w-3 h-3" /> task #{suggestion.context.related_task_ids.join(', #')}
          </span>
        )}
        {suggestion.source && (
          <span className="px-2 py-1 rounded-md bg-slate-800/50 text-slate-500 font-mono">
            📧 {suggestion.source}
          </span>
        )}
      </div>

      {/* THREAD */}
      {replies.length > 0 && (
        <div className="mb-4 p-3 rounded-xl bg-slate-950/50 border border-slate-800/50 space-y-2">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-1">
            <MessageSquare className="w-3 h-3" /> Konverzace ({replies.length})
          </div>
          {replies.map((r) => (
            <div key={r.id} className="flex gap-2 text-[12px] items-start">
              <span
                className={`font-bold shrink-0 ${
                  r.type === 'action' ? 'text-emerald-400' : r.type === 'voice' ? 'text-cyan-400' : 'text-indigo-400'
                }`}
              >
                {r.type === 'action' ? 'Akce' : r.type === 'voice' ? 'Ty' : 'Ty'}
              </span>
              <span className="text-slate-500 shrink-0">{formatTimestamp(r.created_at)}</span>
              {r.type === 'voice' && r.voice_file_id ? (
                <button
                  onClick={() => playVoice(r.id)}
                  className="px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold flex items-center gap-1"
                >
                  {playingVoiceId === r.id ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  {playingVoiceId === r.id ? 'Stop' : 'Přehrát'}
                </button>
              ) : r.type === 'action' ? (
                <span className="text-slate-300">
                  {r.action === 'accept' && '✅ Přijato'}
                  {r.action === 'reject' && '❌ Zamítnuto'}
                  {r.action === 'defer' && `⏰ Odloženo do ${r.action_data?.defer_until || '?'}`}
                </span>
              ) : (
                <span className="text-slate-300">{r.content}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* TEXT REPLY INLINE */}
      {expandedTextReply && !isResolved && (
        <div className="mb-3 p-3 rounded-xl bg-slate-950/50 border border-slate-800/50 space-y-2">
          <textarea
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            placeholder="Text odpovědi pro Anu…"
            rows={3}
            className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-sm placeholder-slate-600 focus:outline-none focus:border-indigo-600 resize-none"
            autoFocus
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { onExpandTextReply(false); setTextValue(''); }}
              className="px-3 py-1.5 rounded-lg text-slate-400 text-[11px] font-black uppercase tracking-widest hover:text-slate-200"
            >
              Zrušit
            </button>
            <button
              onClick={handleTextSubmit}
              disabled={!textValue.trim() || isProcessing}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[11px] font-black uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-500"
            >
              <Check className="w-3 h-3 inline-block mr-1" /> Odeslat
            </button>
          </div>
        </div>
      )}

      {/* DEFER PICKER */}
      {showDeferPicker && !isResolved && (
        <div className="mb-3 p-3 rounded-xl bg-slate-950/50 border border-slate-800/50 space-y-2">
          <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Odložit do:</div>
          <input
            type="date"
            value={deferDate}
            onChange={(e) => setDeferDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:border-indigo-600"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setShowDeferPicker(false); setDeferDate(''); }}
              className="px-3 py-1.5 rounded-lg text-slate-400 text-[11px] font-black uppercase tracking-widest hover:text-slate-200"
            >
              Zrušit
            </button>
            <button
              onClick={handleDeferSubmit}
              disabled={!deferDate || isProcessing}
              className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-[11px] font-black uppercase tracking-widest disabled:opacity-40 hover:bg-amber-500"
            >
              <Hourglass className="w-3 h-3 inline-block mr-1" /> Odložit
            </button>
          </div>
        </div>
      )}

      {/* ACTION BUTTONS */}
      {!isResolved && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onAccept(true)}
            disabled={isProcessing}
            className="px-3 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 text-[11px] font-black uppercase tracking-widest border border-emerald-600/30 hover:bg-emerald-600/30 transition-all disabled:opacity-40"
          >
            <CheckCircle2 className="w-3 h-3 inline-block mr-1" /> Přijmout + task
          </button>
          <button
            onClick={onReject}
            disabled={isProcessing}
            className="px-3 py-1.5 rounded-lg bg-red-600/15 text-red-300 text-[11px] font-black uppercase tracking-widest border border-red-600/25 hover:bg-red-600/25 transition-all disabled:opacity-40"
          >
            <X className="w-3 h-3 inline-block mr-1" /> Zamítnout
          </button>
          <button
            onClick={() => setShowDeferPicker((v) => !v)}
            disabled={isProcessing}
            className="px-3 py-1.5 rounded-lg bg-amber-600/15 text-amber-300 text-[11px] font-black uppercase tracking-widest border border-amber-600/25 hover:bg-amber-600/25 transition-all disabled:opacity-40"
          >
            <Hourglass className="w-3 h-3 inline-block mr-1" /> Odložit
          </button>
          <div className="flex-1" />
          <button
            onClick={() => onExpandTextReply(!expandedTextReply)}
            disabled={isProcessing}
            className="px-3 py-1.5 rounded-lg bg-slate-800/50 text-slate-300 text-[11px] font-black uppercase tracking-widest border border-slate-700/50 hover:bg-slate-800 transition-all disabled:opacity-40"
          >
            <FileText className="w-3 h-3 inline-block mr-1" /> Text
          </button>
          <button
            onClick={isRecording ? stopVoice : startVoice}
            disabled={isProcessing}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-widest border transition-all disabled:opacity-40 ${
              isRecording
                ? 'bg-red-600/20 text-red-300 border-red-600/30 animate-pulse'
                : 'bg-slate-800/50 text-slate-300 border-slate-700/50 hover:bg-slate-800'
            }`}
          >
            <Mic className="w-3 h-3 inline-block mr-1" />
            {isRecording ? 'Stop' : 'Hlas'}
          </button>
        </div>
      )}

      {isResolved && suggestion.status === 'converted' && (
        <div className="text-sm text-slate-500 flex items-center gap-1">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          Anu vytvořil task v Plánu.
        </div>
      )}
    </motion.article>
  );
}
