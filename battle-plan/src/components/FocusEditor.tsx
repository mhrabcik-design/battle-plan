import { motion } from 'framer-motion';
import { Share2, MicOff, Mic, Save, X, Users, CheckCircle2, Hourglass } from 'lucide-react';
import type { UnifiedTask, GoogleAuthStatus } from '../types';
import React from 'react';
import type { Task } from '../db';

interface FocusEditorProps {
    editingTask: UnifiedTask;
    setEditingTask: React.Dispatch<React.SetStateAction<UnifiedTask | null>>;
    activeVoiceUpdateId: number | null;
    isRecording: boolean;
    stopRecording: () => void;
    startRecording: (options: { enableFeedback?: boolean; onSilence?: () => void; silenceThreshold?: number; silenceDuration?: number }) => void;
    setActiveVoiceUpdateId: (id: number | null) => void;
    activeVoiceUpdateIdRef: React.MutableRefObject<number | null>;
    handleDeleteTask: (task: UnifiedTask) => void;
    handleSyncToGoogle: (task: UnifiedTask) => void;
    handleSaveEdit: () => void;
    googleAuth: GoogleAuthStatus;
    isOverCapacity: (task: UnifiedTask) => boolean;
    getDeadlineColor: (date?: string, time?: string) => string;
    formatTimeLeft: (date?: string, time?: string) => string;
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
    handleSaveEdit,
    googleAuth,
    isOverCapacity,
    getDeadlineColor,
    formatTimeLeft
}: FocusEditorProps) {
    return (
        <div className="fixed inset-0 md:left-64 z-[100] flex items-stretch justify-center bg-slate-950/80 backdrop-blur-md overflow-hidden">
            <motion.div
                initial={{ x: '100%', opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: '100%', opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="w-full h-full bg-slate-900 border-l border-white/5 shadow-[0_0_50px_rgba(0,0,0,0.5)] flex flex-col relative"
            >
                <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-indigo-600 to-blue-500" />

                {/* EDITOR HEADER */}
                <div className="p-6 md:px-12 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
                    <div className="flex items-center gap-4">
                        <div className={`p-2 rounded-xl ${editingTask.type === 'meeting' ? 'bg-orange-500/10 text-orange-400' : 'bg-indigo-500/10 text-indigo-400'}`}>
                            {editingTask.type === 'meeting' ? <Users className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-white uppercase tracking-tight">Focus Mode</h2>
                            <p className="text-xs font-bold text-slate-500 uppercase tracking-widest leading-none mt-1">Hluboká editace a detail záznamu</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {!editingTask.isGoogleTask && (
                            <button
                                onClick={() => {
                                    if (activeVoiceUpdateId === editingTask.id) {
                                        stopRecording();
                                    } else {
                                        activeVoiceUpdateIdRef.current = editingTask.id!;
                                        setActiveVoiceUpdateId(editingTask.id!);
                                        startRecording({
                                            enableFeedback: true,
                                            onSilence: () => stopRecording(),
                                            silenceThreshold: -45,
                                            silenceDuration: 4000
                                        });
                                    }
                                }}
                                className={`p-3 rounded-xl transition-all shadow-lg active:scale-95 border ${activeVoiceUpdateId === editingTask.id ? 'bg-red-500 border-red-500 text-white animate-pulse' : 'bg-orange-600/20 border-orange-600/30 text-orange-500 hover:bg-orange-600/40'}`}
                            >
                                {activeVoiceUpdateId === editingTask.id ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                            </button>
                        )}
                        <button
                            disabled={isRecording && activeVoiceUpdateId === editingTask.id}
                            onClick={() => setEditingTask(null)}
                            className={`p-3 rounded-xl transition-all shadow-lg active:scale-95 ${isRecording && activeVoiceUpdateId === editingTask.id ? 'bg-slate-800/50 text-slate-700 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white'}`}
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                {/* EDITOR CONTENT - SCROLLABLE AREA */}
                <div className="flex-1 overflow-y-auto no-scrollbar">
                    <div className="grid grid-cols-1 lg:grid-cols-12 h-full w-full">

                        {/* MAIN CONTENT (LEFT) */}
                        <div className="lg:col-span-8 p-6 md:p-10 space-y-8 border-r border-slate-800/50">
                            <div className="space-y-3">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-1">Název aktivity</label>
                                <input
                                    type="text"
                                    disabled={editingTask.isGoogleTask}
                                    value={editingTask.title}
                                    onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value, updatedAt: Date.now() })}
                                    className="w-full bg-slate-800/30 border border-slate-800 rounded-2xl px-6 py-5 text-2xl font-black text-white focus:border-indigo-500 transition-all outline-none"
                                    placeholder="Na čem pracujeme?"
                                />
                            </div>

                            <div className="space-y-4">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-[0.2em] ml-1">Podrobný popis (Popis a Kontext)</label>
                                <textarea
                                    rows={12}
                                    value={editingTask.description}
                                    onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value, updatedAt: Date.now() })}
                                    className="w-full bg-slate-800/20 border border-slate-800 rounded-2xl px-6 py-6 text-base font-medium text-slate-300 leading-relaxed focus:bg-slate-800/40 focus:border-indigo-500 transition-all outline-none resize-none"
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
                                        className="w-full bg-indigo-950/10 border border-indigo-900/20 rounded-2xl px-6 py-6 text-sm italic font-medium text-indigo-300/60 leading-relaxed focus:border-indigo-500 transition-all outline-none resize-none"
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
                                            <label className="text-sm font-black text-slate-500 uppercase">
                                                {editingTask.type === 'task' ? 'Termín dokončení' : 'Datum konání'}
                                            </label>
                                            <input
                                                type="date"
                                                value={(editingTask.type === 'task' ? (editingTask.deadline || editingTask.date) : (editingTask.date || editingTask.deadline)) || ''}
                                                onChange={(e) => setEditingTask({ ...editingTask, date: e.target.value, deadline: e.target.value, updatedAt: Date.now() })}
                                                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-xs font-bold text-white outline-none"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-black text-slate-500 uppercase">Čas (24h)</label>
                                            <input
                                                type="text"
                                                placeholder="13:00"
                                                maxLength={5}
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
                                                className={`w-full bg-slate-800 border rounded-xl px-4 py-3 text-xs font-bold text-white outline-none placeholder:text-slate-600 ${editingTask.startTime && !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(editingTask.startTime) ? 'border-red-500/50' : 'border-slate-700'}`}
                                            />
                                        </div>
                                    </div>

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
                                            className="text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-lg transition-all font-black uppercase"
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
                                                    className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all ${st.completed ? 'bg-indigo-600 border-indigo-600' : 'border-slate-700 hover:border-indigo-500'}`}
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
                                                    className="p-1 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
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
                </div>

                {/* EDITOR FOOTER */}
                <div className="p-6 md:px-12 bg-slate-900 border-t border-slate-800 flex items-center justify-between gap-4">
                    <button
                        disabled={isRecording && activeVoiceUpdateId === editingTask.id}
                        onClick={() => { handleDeleteTask(editingTask); setEditingTask(null); }}
                        className={`px-4 md:px-6 py-3.5 rounded-xl border transition-all shadow-lg shadow-red-500/5 text-xs md:text-sm font-black uppercase ${isRecording && activeVoiceUpdateId === editingTask.id ? 'bg-slate-800/50 border-slate-700 text-slate-600 cursor-not-allowed' : 'bg-red-600/10 border-red-500/20 text-red-500 hover:bg-red-600 hover:text-white'}`}
                    >
                        {window.innerWidth < 768 ? 'Smazat' : 'Odstranit záznam'}
                    </button>

                    <div className="flex items-center gap-4">
                        {editingTask.type === 'meeting' && !editingTask.isGoogleTask && googleAuth.isSignedIn && (
                            <button
                                onClick={() => handleSyncToGoogle(editingTask)}
                                className={`px-8 py-3.5 rounded-xl text-sm font-black uppercase flex items-center gap-2 transition-all ${editingTask.googleEventId ? 'bg-emerald-600 text-white shadow-lg' : 'bg-slate-800 text-emerald-400 border border-emerald-500/30'}`}
                            >
                                <Share2 className="w-4 h-4" />
                                {editingTask.googleEventId ? 'Synchronizováno' : 'Odeslat do Kalendáře'}
                            </button>
                        )}

                        <div className="flex items-center gap-3">
                            {!editingTask.isGoogleTask && (
                                <button
                                    onClick={() => {
                                        if (activeVoiceUpdateId === editingTask.id) {
                                            stopRecording();
                                        } else {
                                            activeVoiceUpdateIdRef.current = editingTask.id!;
                                            setActiveVoiceUpdateId(editingTask.id!);
                                            startRecording({
                                                enableFeedback: true,
                                                onSilence: () => stopRecording(),
                                                silenceThreshold: -45,
                                                silenceDuration: 4000
                                            });
                                        }
                                    }}
                                    className={`h-11 px-4 rounded-xl transition-all border flex items-center gap-2 font-black uppercase text-xs ${activeVoiceUpdateId === editingTask.id ? 'bg-red-500 border-red-500 text-white animate-pulse' : 'bg-orange-600/10 border-orange-500/30 text-orange-500 hover:bg-orange-600/20 shadow-lg shadow-orange-950/10'}`}
                                >
                                    <Mic className="w-4 h-4" />
                                    {activeVoiceUpdateId === editingTask.id ? 'Zastavit' : 'Diktovat'}
                                </button>
                            )}

                            <button
                                onClick={handleSaveEdit}
                                className="px-6 md:px-12 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-black uppercase text-xs rounded-xl shadow-xl shadow-indigo-600/30 transition-all active:scale-95 whitespace-nowrap"
                            >
                                <Save className="w-4 h-4 md:mr-2 inline" />
                                <span className="hidden md:inline">Uložit změny</span>
                                <span className="md:hidden">Uložit</span>
                            </button>
                        </div>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}
