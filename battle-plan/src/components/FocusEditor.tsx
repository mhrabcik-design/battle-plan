import { Share2, MicOff, Mic, Save, X, Users, CheckCircle2, Hourglass, Sun, Mail, Copy, ExternalLink } from 'lucide-react';
import type { UnifiedTask, GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';
import React, { useState, useEffect, useRef } from 'react';
import type { Task } from '../db';
import { formatDuration, parseDuration } from '../utils/calendarUtils';
import type { EditorSaveOutcome } from '../hooks/useTaskCommands';
import { applySavedEditorStatus, getEditorCloseIntent, getEditorTaskSnapshot } from '../utils/editorInteraction';
import { OverlaySurface } from './ui/OverlaySurface';
import { buildTaskEmail } from '../utils/taskSharing';

interface FocusEditorProps {
    editingTask: UnifiedTask;
    setEditingTask: React.Dispatch<React.SetStateAction<UnifiedTask | null>>;
    activeVoiceUpdateId: number | null;
    isRecording: boolean;
    stopRecording: () => void;
    startRecording: (options: { enableFeedback?: boolean; onSilence?: () => void; silenceThreshold?: number; silenceDuration?: number }) => void | Promise<void>;
    setActiveVoiceUpdateId: (id: number | null) => void;
    activeVoiceUpdateIdRef: React.MutableRefObject<number | null>;
    handleDeleteTask: (task: UnifiedTask) => Promise<boolean>;
    handleSyncToGoogle: (task: UnifiedTask) => void;
    handleExport: (task: UnifiedTask) => void;
    handlePrepareInvitation: (task: UnifiedTask) => Promise<string>;
    handleSaveEdit: () => Promise<EditorSaveOutcome>;
    handleToggleTask: (task: UnifiedTask) => Promise<UnifiedTask | null>;
    googleAuth: GoogleAuthStatus;
    isOverCapacity: (task: UnifiedTask) => boolean;
    getDeadlineColor: (date?: string, time?: string) => string;
    formatTimeLeft: (date?: string, time?: string) => string;
    onNotice: (message: string) => void;
}

export function FocusEditor({
    editingTask,
    setEditingTask,
    activeVoiceUpdateId,
    isRecording,
    stopRecording,
    startRecording,
    setActiveVoiceUpdateId,
    activeVoiceUpdateIdRef,
    handleDeleteTask,
    handleSyncToGoogle,
    handleExport,
    handlePrepareInvitation,
    handleSaveEdit,
    handleToggleTask,
    googleAuth,
    isOverCapacity,
    getDeadlineColor,
    formatTimeLeft,
    onNotice,
}: FocusEditorProps) {
    const [isTogglingTask, setIsTogglingTask] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isPreparingInvitation, setIsPreparingInvitation] = useState(false);
    const [invitationLink, setInvitationLink] = useState<{ key: string; url: string } | null>(null);
    const [shareNotice, setShareNotice] = useState('');
    const [showShareText, setShowShareText] = useState(false);
    const [editorError, setEditorError] = useState<string | null>(null);
    const [initialTask, setInitialTask] = useState(editingTask);
    const mutationRef = useRef(false);
    const titleRef = useRef<HTMLInputElement>(null);
    const currentSnapshot = getEditorTaskSnapshot(editingTask);
    const isDirty = getEditorTaskSnapshot(initialTask) !== currentSnapshot;
    const isBusy = isSaving || isDeleting || isTogglingTask || isPreparingInvitation;
    const hasSavedIdentity = Boolean(editingTask.id || (editingTask.isGoogleTask && editingTask.googleId));
    const shareDisabled = isBusy || isDirty || !hasSavedIdentity || isRecording;
    const invitationKey = `${currentSnapshot}:${googleAuth.accessToken}`;
    const shareText = showShareText ? buildTaskEmail(editingTask) : null;
    const readyLink = !shareDisabled && hasUsableAuth(googleAuth) && invitationLink?.key === invitationKey ? invitationLink.url : null;
    const editorTitle = hasSavedIdentity ? 'Detail záznamu' : {
        task: 'Nový úkol', meeting: 'Nová schůzka', thought: 'Nová myšlenka', note: 'Nová poznámka',
    }[editingTask.type];

    useEffect(() => {
        const frame = requestAnimationFrame(() => titleRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, []);

    const requestClose = () => {
        if (mutationRef.current) return;
        const intent = getEditorCloseIntent({
            recording: isRecording && activeVoiceUpdateId === editingTask.id,
            dirty: isDirty,
        });
        if (intent === 'stop-recording') {
            stopRecording();
            return;
        }
        if (intent === 'confirm-discard' && !confirm('Zahodit neuložené změny?')) return;
        setEditingTask(null);
    };

    const deleteTask = async () => {
        if (mutationRef.current || !hasSavedIdentity) return;
        mutationRef.current = true;
        setIsDeleting(true);
        setEditorError(null);
        try {
            if (await handleDeleteTask(editingTask)) setEditingTask(null);
            else setEditorError('Záznam se nepodařilo smazat. Zkontrolujte připojení a přihlášení.');
        } catch (error) {
            setEditorError(error instanceof Error ? error.message : 'Záznam se nepodařilo smazat.');
        } finally {
            mutationRef.current = false;
            setIsDeleting(false);
        }
    };

    const saveTask = async () => {
        if (mutationRef.current) return;
        mutationRef.current = true;
        setIsSaving(true);
        setEditorError(null);
        try {
            const outcome = await handleSaveEdit();
            if (outcome.status === 'failed') {
                setEditorError(outcome.message);
                return;
            }
            setEditingTask(null);
            if (outcome.status === 'success-sync-warning') onNotice(outcome.message);
        } catch (error) {
            setEditorError(error instanceof Error ? error.message : 'Změny se nepodařilo uložit.');
        } finally {
            mutationRef.current = false;
            setIsSaving(false);
        }
    };

    const toggleWholeTask = async () => {
        if (mutationRef.current || !hasSavedIdentity) return;
        mutationRef.current = true;
        setIsTogglingTask(true);
        setEditorError(null);
        try {
            const updatedTask = await handleToggleTask(editingTask);
            if (updatedTask) {
                setInitialTask(previous => applySavedEditorStatus(previous, updatedTask));
                setEditingTask(previous => previous ? applySavedEditorStatus(previous, updatedTask) : null);
            } else {
                setEditorError('Stav se nepodařilo změnit. Záznam už nemusí být dostupný.');
            }
        } catch (error) {
            setEditorError(error instanceof Error ? error.message : 'Stav se nepodařilo změnit.');
        } finally {
            mutationRef.current = false;
            setIsTogglingTask(false);
        }
    };

    const copyShareText = async () => {
        const { subject, body } = buildTaskEmail(editingTask);
        try {
            await navigator.clipboard.writeText(`${subject}\r\n\r\n${body}`);
            setShareNotice('Obsah je zkopírovaný. Vložte jej do svého e-mailu.');
        } catch {
            setShowShareText(true);
            setShareNotice('Kopírování není dostupné. Označte a zkopírujte text níže.');
        }
    };

    const prepareInvitation = async () => {
        if (mutationRef.current || shareDisabled) return;
        mutationRef.current = true;
        setIsPreparingInvitation(true);
        setInvitationLink(null);
        setShareNotice('');
        setEditorError(null);
        try {
            const url = await handlePrepareInvitation(editingTask);
            setInvitationLink({ key: invitationKey, url });
        } catch (error) {
            setEditorError(error instanceof Error ? error.message : 'Pozvání se nepodařilo připravit. Zkuste to znovu.');
        } finally {
            mutationRef.current = false;
            setIsPreparingInvitation(false);
        }
    };

    return (
        <OverlaySurface
            title={`${editorTitle}${editingTask.title ? `: ${editingTask.title}` : ''}`}
            onRequestClose={requestClose}
            variant="sheet"
            closeOnBackdrop={false}
            className="relative flex h-full w-full flex-col overflow-hidden border-l border-white/10 bg-slate-900 shadow-[0_0_50px_rgba(0,0,0,0.5)]"
        >
                <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-indigo-600 to-blue-500" />

                {/* EDITOR HEADER */}
                <div className="p-6 md:px-12 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
                    <div className="flex items-center gap-4">
                        <div className={`p-2 rounded-xl ${editingTask.type === 'meeting' ? 'bg-orange-500/10 text-orange-400' : 'bg-indigo-500/10 text-indigo-400'}`}>
                            {editingTask.type === 'meeting' ? <Users className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white tracking-tight">{editorTitle}</h2>
                            <p className="text-xs text-slate-400 leading-snug mt-1">{hasSavedIdentity ? 'Souvislosti, termín a další kroky.' : 'Začněte názvem. Ostatní můžete doplnit později.'}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {!editingTask.isGoogleTask && hasSavedIdentity && (
                            <button
                                type="button"
                                disabled={isBusy}
                                aria-label={activeVoiceUpdateId === editingTask.id ? 'Zastavit diktování' : 'Spustit diktování'}
                                onClick={() => {
                                    if (activeVoiceUpdateId === editingTask.id) {
                                        stopRecording();
                                    } else {
                                        activeVoiceUpdateIdRef.current = editingTask.id!;
                                        setActiveVoiceUpdateId(editingTask.id!);
                                        void Promise.resolve(startRecording({
                                            enableFeedback: true,
                                            onSilence: () => stopRecording(),
                                            silenceThreshold: -45,
                                            silenceDuration: 4000
                                        })).catch((err: unknown) => {
                                            console.error('Focus voice recording failed', err);
                                        });
                                    }
                                }}
                                className={`min-h-11 min-w-11 inline-flex items-center justify-center rounded-xl transition-[background-color,border-color,color,transform] shadow-lg active:scale-95 border ${activeVoiceUpdateId === editingTask.id ? 'bg-red-500 border-red-500 text-white animate-pulse' : 'bg-orange-600/20 border-orange-600/30 text-orange-500 hover:bg-orange-600/40'}`}
                            >
                                {activeVoiceUpdateId === editingTask.id ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                            </button>
                        )}
                        <button
                            disabled={isBusy || (isRecording && activeVoiceUpdateId === editingTask.id)}
                            onClick={requestClose}
                            aria-label="Zavřít editor"
                            className={`min-h-11 min-w-11 inline-flex items-center justify-center rounded-xl transition-[background-color,color,transform] shadow-lg active:scale-95 ${isRecording && activeVoiceUpdateId === editingTask.id ? 'bg-slate-800/50 text-slate-700 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white'}`}
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                {/* EDITOR CONTENT - SCROLLABLE AREA */}
                <fieldset disabled={isBusy} className="m-0 min-w-0 flex-1 overflow-y-auto border-0 p-0 no-scrollbar">
                    {editorError && (
                        <div role="alert" className="mx-4 mt-4 rounded-xl border border-red-500/40 bg-red-950/70 px-4 py-3 text-sm font-bold text-red-200 md:mx-10">
                            {editorError}
                        </div>
                    )}
                    <div className="grid grid-cols-1 lg:grid-cols-12 h-full w-full">

                        {/* MAIN CONTENT (LEFT) */}
                        <div className="lg:col-span-8 p-6 md:p-10 space-y-8 border-r border-slate-800/50">
                            <div className="space-y-3">
                                <label htmlFor="task-title" className="text-xs font-bold text-slate-400 ml-1">Název aktivity</label>
                                <input
                                    id="task-title"
                                    ref={titleRef}
                                    autoFocus
                                    type="text"
                                    required
                                    aria-invalid={!!editorError && !editingTask.title.trim()}
                                    disabled={editingTask.isGoogleTask}
                                    value={editingTask.title}
                                    onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value, updatedAt: Date.now() })}
                                    className="w-full bg-slate-800/30 border border-slate-800 rounded-2xl px-6 py-5 text-2xl font-bold text-white focus:border-indigo-500 transition-[background-color,border-color,color] outline-none"
                                    placeholder="Na čem pracujeme?"
                                />
                            </div>

                            <section aria-label="Sdílení záznamu" className="space-y-3 rounded-2xl border border-slate-700 bg-slate-800/30 p-4">
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" disabled={shareDisabled} onClick={() => handleExport(editingTask)} className="surface-action min-h-11 gap-2 px-3 text-sm text-slate-200 disabled:opacity-50"><Mail className="h-4 w-4" />Sdílet e-mailem</button>
                                    <button type="button" disabled={shareDisabled} onClick={() => { void copyShareText(); }} className="surface-action min-h-11 gap-2 px-3 text-sm text-slate-200 disabled:opacity-50"><Copy className="h-4 w-4" />Kopírovat obsah</button>
                                    {editingTask.type === 'meeting' && !editingTask.isGoogleTask && (
                                        <button type="button" disabled={shareDisabled || !hasUsableAuth(googleAuth)} aria-busy={isPreparingInvitation} onClick={() => { void prepareInvitation(); }} className="surface-action min-h-11 gap-2 px-3 text-sm text-indigo-300 disabled:opacity-50"><Users className="h-4 w-4" />{isPreparingInvitation ? 'Připravuji schůzku…' : 'Pozvat přes Google Kalendář'}</button>
                                    )}
                                </div>
                                <p className="text-xs leading-relaxed text-slate-400">{!hasSavedIdentity || isDirty ? 'Před sdílením nejprve uložte změny.' : 'E-mail se otevře ve vašem poštovním klientu. Interní zápis se nesdílí.'}</p>
                                {editingTask.type === 'meeting' && (
                                    <p className="text-xs leading-relaxed text-slate-400">{!hasUsableAuth(googleAuth) ? 'Pro pozvánky se přihlaste ke Googlu v Nastavení. ' : ''}Hosty přidáte a pozvánky odešlete v Google Kalendáři. Název, popis a termín upravujte zde; změny propojené schůzky i její smazání se oznámí případným hostům.</p>
                                )}
                                {readyLink && <div role="status"><a href={readyLink} target="_blank" rel="noopener noreferrer" className="surface-action min-h-11 gap-2 px-3 text-sm text-indigo-300"><ExternalLink className="h-4 w-4" />Otevřít Google Kalendář</a><p className="mt-2 text-xs text-slate-400">Schůzka je připravená. Pozvánky odešlete až po přidání hostů v Google Kalendáři.</p></div>}
                                {shareNotice && <p role="status" className="text-xs text-slate-300">{shareNotice}</p>}
                                {shareText && !shareDisabled && <textarea aria-label="Obsah ke zkopírování" readOnly rows={8} onFocus={event => event.currentTarget.select()} value={`${shareText.subject}\r\n\r\n${shareText.body}`} className="w-full rounded-xl border border-slate-600 bg-slate-900 p-3 text-sm text-slate-200" />}
                            </section>

                            <div className="space-y-4">
                                <label htmlFor="task-description" className="text-xs font-bold text-slate-400 ml-1">Popis a souvislosti</label>
                                <textarea
                                    id="task-description"
                                    rows={12}
                                    value={editingTask.description || ''}
                                    onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value, updatedAt: Date.now() })}
                                    className="w-full bg-slate-800/20 border border-slate-800 rounded-2xl px-6 py-6 text-base font-medium text-slate-300 leading-relaxed focus:bg-slate-800/40 focus:border-indigo-500 transition-[background-color,border-color,color] outline-none resize-none"
                                    placeholder="Zde rozveďte své myšlenky..."
                                />
                            </div>

                            {!editingTask.isGoogleTask && (
                                <div className="space-y-4">
                                    <label className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-1">Interní Zápisy (Pouze pro AI)</label>
                                    <textarea
                                        rows={8}
                                        value={editingTask.internalNotes || ''}
                                        onChange={(e) => setEditingTask({ ...editingTask, internalNotes: e.target.value, updatedAt: Date.now() })}
                                        className="w-full bg-indigo-950/10 border border-indigo-900/20 rounded-2xl px-6 py-6 text-sm italic font-medium text-indigo-300/60 leading-relaxed focus:border-indigo-500 transition-[background-color,border-color,color] outline-none resize-none"
                                        placeholder="Dodatečné technické poznámky nebo AI instrukce..."
                                    />
                                </div>
                            )}
                        </div>

                        {/* PROPERTIES & ACTIONS (RIGHT) */}
                        <div className="lg:col-span-4 bg-slate-900/30 p-6 md:p-10 space-y-10">
                            <div className="space-y-6">
                                <h3 className="text-sm font-black text-white uppercase tracking-[0.3em] border-b border-slate-800 pb-3">Parametry</h3>

                                <div className="grid grid-cols-1 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-sm font-black text-slate-500 uppercase">Typ záznamu</label>
                                        <select
                                            disabled={editingTask.isGoogleTask}
                                            value={editingTask.type}
                                            onChange={(e) => setEditingTask({ ...editingTask, type: e.target.value as Task['type'], updatedAt: Date.now() })}
                                            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-xs font-bold uppercase text-white outline-none cursor-pointer"
                                        >
                                            <option value="task">Úkol</option>
                                            <option value="meeting">Schůzka</option>
                                            <option value="thought">Myšlenka</option>
                                        </select>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label htmlFor="task-deadline" className="text-sm font-black text-slate-500 uppercase">
                                                {editingTask.type === 'task' ? 'Termín dokončení' : 'Datum konání'}
                                            </label>
                                            <input
                                                id="task-deadline"
                                                aria-describedby={editingTask.type === 'task' ? 'task-deadline-hint' : undefined}
                                                type="date"
                                                value={(editingTask.type === 'task' ? (editingTask.deadline || editingTask.date) : (editingTask.date || editingTask.deadline)) || ''}
                                                onChange={(e) => setEditingTask({ ...editingTask, date: e.target.value, deadline: e.target.value, updatedAt: Date.now() })}
                                                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-xs font-bold text-white outline-none"
                                            />
                                            {editingTask.type === 'task' && (
                                                <p id="task-deadline-hint" className="text-xs text-slate-400">
                                                    Bez termínu se úkol uloží na pátek tohoto týdne.
                                                </p>
                                            )}
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-black text-slate-500 uppercase">Čas (24h)</label>
                                            <input
                                                type="text"
                                                placeholder="13:00"
                                                maxLength={5}
                                                disabled={editingTask.isAllDay}
                                                value={editingTask.startTime || ''}
                                                onChange={(e) => {
                                                    let val = e.target.value.replace(/[^\d:]/g, '');
                                                    if (val.length === 2 && !val.includes(':') && val.length > (editingTask.startTime?.length || 0)) {
                                                        const hours = parseInt(val);
                                                        if (hours > 23) val = '23';
                                                        val += ':';
                                                    }
                                                    if (val.length === 5) {
                                                        const parts = val.split(':');
                                                        const mins = parseInt(parts[1]);
                                                        if (mins > 59) val = parts[0] + ':59';
                                                    }
                                                    setEditingTask({ ...editingTask, startTime: val, updatedAt: Date.now() });
                                                }}
                                                className={`w-full bg-slate-800 border rounded-xl px-4 py-3 text-xs font-bold text-white outline-none placeholder:text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed ${editingTask.startTime && !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(editingTask.startTime) ? 'border-red-500/50' : 'border-slate-700'}`}
                                            />
                                        </div>
                                    </div>

                                    {/* ALL-DAY TOGGLE + DURATION INPUT */}
                                    <DurationAllDayEditor
                                        editingTask={editingTask}
                                        setEditingTask={setEditingTask}
                                        isGoogleTask={!!editingTask.isGoogleTask}
                                    />

                                    {!editingTask.isGoogleTask && (
                                        <div className="space-y-3">
                                            <label className="text-sm font-black text-slate-500 uppercase flex justify-between">
                                                <span>Urgence / Priorita</span>
                                                <span className="text-white">{editingTask.urgency}/3</span>
                                            </label>
                                            <input
                                                type="range" min="1" max="3"
                                                value={editingTask.urgency}
                                                onChange={(e) => setEditingTask({ ...editingTask, urgency: Math.min(3, Math.max(1, Number(e.target.value))) as 1 | 2 | 3, updatedAt: Date.now() })}
                                                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                                            />
                                        </div>
                                    )}

                                    {editingTask.type === 'task' && (editingTask.deadline || editingTask.date) && (
                                        <div className={`p-4 rounded-2xl border flex items-center gap-3 transition-colors ${isOverCapacity(editingTask) ? 'bg-red-500/10 border-red-500/20 shadow-lg shadow-red-500/5' : 'bg-slate-800/40 border-slate-700/60'}`}>
                                            <Hourglass className={`w-5 h-5 ${isOverCapacity(editingTask) ? 'text-red-400 animate-pulse' : getDeadlineColor(editingTask.deadline || editingTask.date, editingTask.startTime)}`} />
                                            <div className="flex flex-col">
                                                <span className="text-xs font-black text-slate-500 uppercase tracking-widest leading-none mb-1">Do termínu zbývá</span>
                                                <span className={`text-sm font-black uppercase tracking-tight ${isOverCapacity(editingTask) ? 'text-red-400' : getDeadlineColor(editingTask.deadline || editingTask.date, editingTask.startTime)}`}>
                                                    {formatTimeLeft(editingTask.deadline || editingTask.date, editingTask.startTime)}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {!editingTask.isGoogleTask && (
                                <div className="space-y-6">
                                    <div className="flex justify-between items-center">
                                        <h3 className="text-sm font-black text-white uppercase tracking-[0.3em]">Checklist</h3>
                                        <button
                                            onClick={() => {
                                                const newSubTasks = [...(editingTask.subTasks || []), { id: Date.now().toString(), title: '', completed: false }];
                                                setEditingTask({ ...editingTask, subTasks: newSubTasks, updatedAt: Date.now() });
                                            }}
                                            className="min-h-9 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-lg transition-[background-color,border-color,color] font-black uppercase"
                                        >
                                            + Přidat krok
                                        </button>
                                    </div>

                                    <div className="space-y-2 max-h-[300px] overflow-y-auto no-scrollbar pr-1">
                                        {editingTask.subTasks?.map((st) => (
                                            <div key={st.id} className="group flex gap-3 items-start bg-slate-800/40 p-3 rounded-xl border border-slate-800/50">
                                                <button
                                                    onClick={() => {
                                                        const newSubTasks = editingTask.subTasks?.map(item => item.id === st.id ? { ...item, completed: !item.completed } : item);
                                                        setEditingTask({ ...editingTask, subTasks: newSubTasks, updatedAt: Date.now() });
                                                    }}
                                                    className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 mt-0.5 transition-[background-color,border-color] ${st.completed ? 'bg-indigo-600 border-indigo-600' : 'border-slate-700 hover:border-indigo-500'}`}
                                                >
                                                    {st.completed && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                                                </button>
                                                <input
                                                    value={st.title}
                                                    onChange={(e) => {
                                                        const newSubTasks = editingTask.subTasks?.map(item => item.id === st.id ? { ...item, title: e.target.value } : item);
                                                        setEditingTask({ ...editingTask, subTasks: newSubTasks, updatedAt: Date.now() });
                                                    }}
                                                    className={`bg-transparent border-none focus:ring-0 text-[13px] flex-1 text-white ${st.completed ? 'line-through text-slate-600' : 'font-bold'}`}
                                                    placeholder="Popis kroku..."
                                                />
                                                <button
                                                    onClick={() => {
                                                        const newSubTasks = editingTask.subTasks?.filter(item => item.id !== st.id);
                                                        setEditingTask({ ...editingTask, subTasks: newSubTasks, updatedAt: Date.now() });
                                                    }}
                                                    className="min-h-9 min-w-9 inline-flex items-center justify-center rounded-lg text-slate-600 hover:bg-red-500/10 hover:text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-[background-color,color,opacity]"
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </fieldset>

                {/* EDITOR FOOTER */}
                <div className="grid grid-cols-1 gap-3 border-t border-slate-800 bg-slate-900 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:flex md:items-center md:justify-between md:px-12">
                    {hasSavedIdentity ? <button
                        disabled={(isRecording && activeVoiceUpdateId === editingTask.id) || isBusy}
                        onClick={() => { void deleteTask(); }}
                        className={`surface-action min-h-11 px-4 text-xs uppercase md:px-6 md:text-sm ${isRecording && activeVoiceUpdateId === editingTask.id ? 'cursor-not-allowed border-slate-700 bg-slate-800/50 text-slate-600' : 'border-red-500/20 bg-red-600/10 text-red-400 hover:bg-red-600 hover:text-white'}`}
                    >
                        {isDeleting ? 'Mažu…' : 'Odstranit záznam'}
                    </button> : <button type="button" disabled={isBusy} onClick={requestClose} className="surface-action min-h-11 border-slate-700 bg-slate-800 px-4 text-sm text-slate-300 hover:bg-slate-700">Zrušit</button>}

                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:justify-end">
                        {hasSavedIdentity && editingTask.type === 'task' && (
                            <button
                                type="button"
                                onClick={toggleWholeTask}
                                disabled={isBusy}
                                aria-pressed={editingTask.status === 'completed'}
                                aria-busy={isTogglingTask}
                                className={`surface-action min-w-0 gap-2 px-4 text-xs uppercase md:px-6 md:text-sm ${editingTask.status === 'completed' ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300' : 'bg-slate-800 border-slate-700 text-slate-200 hover:border-emerald-500/60'} disabled:opacity-50 disabled:cursor-wait`}
                            >
                                <CheckCircle2 className="w-4 h-4" />
                                {isTogglingTask ? 'Ukládám…' : editingTask.status === 'completed' ? 'Znovu otevřít' : 'Označit splněno'}
                            </button>
                        )}
                        {hasSavedIdentity && editingTask.type === 'meeting' && !editingTask.isGoogleTask && hasUsableAuth(googleAuth) && (
                            <button
                                disabled={isBusy}
                                onClick={() => handleSyncToGoogle(editingTask)}
                                className={`surface-action min-w-0 gap-2 px-5 text-xs uppercase md:text-sm ${editingTask.googleEventId ? 'bg-emerald-600 text-white shadow-lg' : 'bg-slate-800 text-emerald-400 border-emerald-500/30'}`}
                            >
                                <Share2 className="w-4 h-4" />
                                {editingTask.googleEventId ? 'Synchronizováno' : 'Odeslat do Kalendáře'}
                            </button>
                        )}

                        <button
                            onClick={() => { void saveTask(); }}
                            disabled={isBusy}
                            aria-busy={isSaving}
                            className="surface-action min-w-0 gap-2 border-indigo-500/40 bg-indigo-600 px-6 text-xs uppercase text-white shadow-xl shadow-indigo-600/30 hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60 md:px-10"
                        >
                            <Save className="h-4 w-4" />
                            {isSaving ? 'Ukládám…' : hasSavedIdentity ? 'Uložit změny' : 'Vytvořit záznam'}
                        </button>
                    </div>
                </div>
        </OverlaySurface>
    );
}

/**
 * Sub-komponenta pro nastavení celodenního eventu a trvání.
 * - All-day toggle: přepíná isAllDay, při true se startTime a duration ignorují
 * - Duration input: formát "2h 30m" / "90m" / "2:30"
 * - Pokud je all-day, duration input je skryt
 */
function DurationAllDayEditor({
    editingTask,
    setEditingTask,
    isGoogleTask
}: {
    editingTask: UnifiedTask;
    setEditingTask: React.Dispatch<React.SetStateAction<UnifiedTask | null>>;
    isGoogleTask: boolean;
}) {
    const isAllDay = !!editingTask.isAllDay;
    const [durationText, setDurationText] = useState<string>(formatDuration(editingTask.duration));

    useEffect(() => {
        queueMicrotask(() => setDurationText(formatDuration(editingTask.duration)));
    }, [editingTask.duration]);

    const handleDurationBlur = () => {
        const parsed = parseDuration(durationText);
        if (parsed !== null) {
            setEditingTask({ ...editingTask, duration: parsed, updatedAt: Date.now() });
            setDurationText(formatDuration(parsed));
        } else if (durationText.trim() === '') {
            setEditingTask({ ...editingTask, duration: undefined, updatedAt: Date.now() });
        } else {
            setDurationText(formatDuration(editingTask.duration));
        }
    };

    const handleAllDayToggle = () => {
        const newAllDay = !isAllDay;
        setEditingTask({
            ...editingTask,
            isAllDay: newAllDay,
            startTime: newAllDay ? undefined : editingTask.startTime,
            updatedAt: Date.now()
        });
    };

    return (
        <div className="space-y-3">
            <button
                type="button"
                onClick={handleAllDayToggle}
                aria-pressed={isAllDay}
                disabled={isGoogleTask}
                className={`w-full flex items-center justify-between gap-3 p-3 rounded-xl border transition-[background-color,border-color,color,opacity,transform] ${isAllDay ? 'bg-amber-500/10 border-amber-500/40 shadow-lg shadow-amber-500/5' : 'bg-slate-800/40 border-slate-700/60 hover:border-slate-600'} ${isGoogleTask ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer active:scale-[0.99]'}`}
            >
                <div className="flex items-center gap-2.5">
                    <Sun className={`w-4 h-4 ${isAllDay ? 'text-amber-400' : 'text-slate-500'}`} />
                    <div className="text-left">
                        <span className={`text-xs font-black uppercase tracking-wider block ${isAllDay ? 'text-amber-300' : 'text-slate-300'}`}>
                            Celý den
                        </span>
                        <span className="text-sm text-slate-500 leading-none">
                            {isAllDay ? 'Bez konkrétního času' : 'S časem a trváním'}
                        </span>
                    </div>
                </div>
                <div className={`w-10 h-5 rounded-full transition-colors relative ${isAllDay ? 'bg-amber-500' : 'bg-slate-700'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-md transition-[left] ${isAllDay ? 'left-5' : 'left-0.5'}`} />
                </div>
            </button>

            {!isAllDay && (
                <div className="space-y-2">
                    <label className="text-sm font-black text-slate-500 uppercase flex justify-between">
                        <span>Trvání</span>
                        {editingTask.duration != null && (
                            <span className="text-indigo-400 text-xs">{editingTask.duration} min</span>
                        )}
                    </label>
                    <input
                        type="text"
                        placeholder="2h 30m / 90m / 2:30"
                        value={durationText}
                        onChange={(e) => setDurationText(e.target.value)}
                        onBlur={handleDurationBlur}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-xs font-bold text-white outline-none placeholder:text-slate-600 focus:border-indigo-500 transition-[background-color,border-color,color]"
                    />
                </div>
            )}
        </div>
    );
}
