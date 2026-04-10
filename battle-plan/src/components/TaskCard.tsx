import { motion } from 'framer-motion';
import { AlertCircle, Mail, X, Clock, Users, Lightbulb, CheckCircle2, Hourglass, Mic, FileText } from 'lucide-react';
import type { UnifiedTask } from '../types';

interface TaskCardProps {
    task: UnifiedTask;
    activeVoiceUpdateId: number | null;
    isOverCapacity: (task: UnifiedTask) => boolean;
    getUrgencyColor: (urgency: number | undefined) => string;
    handleExport: (task: UnifiedTask) => void;
    handleDeleteTask: (task: UnifiedTask) => void;
    getDeadlineColor: (date?: string, time?: string) => string;
    formatTimeLeft: (date?: string, time?: string) => string;
    toggleSubtask: (task: UnifiedTask, subtaskId: string) => void;
    handleToggleTask: (task: UnifiedTask) => Promise<void>;
    setEditingTask: (task: UnifiedTask) => void;
    stopRecording: () => void;
    setActiveVoiceUpdateId: (id: number) => void;
    activeVoiceUpdateIdRef: React.MutableRefObject<number | null>;
    startRecording: (options: { enableFeedback?: boolean; onSilence?: () => void; silenceThreshold?: number; silenceDuration?: number }) => void;
}

export function TaskCard({
    task,
    activeVoiceUpdateId,
    isOverCapacity,
    getUrgencyColor,
    handleExport,
    handleDeleteTask,
    getDeadlineColor,
    formatTimeLeft,
    toggleSubtask,
    handleToggleTask,
    setEditingTask,
    stopRecording,
    setActiveVoiceUpdateId,
    activeVoiceUpdateIdRef,
    startRecording
}: TaskCardProps) {
    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className={`office-card group relative ${task.status === 'completed' ? 'opacity-50 grayscale-[0.3]' : ''} ${isOverCapacity(task) ? 'animate-pulse-red border-red-500/40 bg-red-950/20' : ''}`}
        >
            {isOverCapacity(task) && (
                <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 bg-red-500/20 border border-red-500/40 rounded-full text-red-400 z-20">
                    <AlertCircle className="w-3 h-3" />
                    <span className="text-xs font-black uppercase tracking-widest">Nedostatek kapacity</span>
                </div>
            )}

            <div className="flex justify-between items-start mb-3">
                <div className="flex items-center gap-2">
                    <div className={`text-xs font-black uppercase tracking-widest px-2 py-0.5 rounded border ${getUrgencyColor(task.urgency)}`}>
                        {task.isGoogleTask ? 'Google Task' : task.urgency === 3 ? 'Urgentní' : task.urgency === 1 ? 'Bez urgentnosti' : 'Normální'}
                    </div>
                    {task.isGoogleTask && (
                        <div className="w-4 h-4 bg-blue-600 rounded flex items-center justify-center text-xs font-black text-white shadow-sm">G</div>
                    )}
                </div>
                <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => { e.stopPropagation(); handleExport(task); }} className="p-1.5 rounded-lg bg-slate-800/50 text-slate-500 hover:text-white transition-all"><Mail className="w-3.5 h-3.5" /></button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteTask(task); }} className="p-1.5 rounded-lg bg-red-900/10 text-red-500/50 hover:text-red-400 hover:bg-red-900/20 transition-all"><X className="w-3.5 h-3.5" /></button>
                    {task.startTime && (
                        <div className="h-6 px-2 bg-slate-800 rounded-md flex items-center gap-1.5 border border-slate-700">
                            <Clock className="w-3 h-3 text-indigo-400" />
                            <span className="text-xs font-black text-white">{task.startTime}</span>
                        </div>
                    )}
                </div>
            </div>

            <div className="mb-4">
                <div className="flex items-start gap-3">
                    <div className={`mt-0.5 p-2 rounded-lg ${task.type === 'meeting' ? 'bg-orange-500/10 text-orange-400' : task.type === 'thought' ? 'bg-yellow-500/10 text-yellow-400' : 'bg-indigo-500/10 text-indigo-400'}`}>
                        {task.type === 'meeting' ? <Users className="w-4 h-4" /> : task.type === 'thought' ? <Lightbulb className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-black text-white uppercase tracking-tight leading-tight mb-1 group-hover:text-indigo-400 transition-colors">{task.title}</h3>
                        <p className="text-xs text-slate-500 line-clamp-2 font-medium leading-relaxed mb-3">{task.description}</p>

                        {task.type === 'task' && task.deadline && (
                            <div className={`mt-2 flex items-center gap-2 p-2 rounded-lg border ${isOverCapacity(task) ? 'bg-red-500/10 border-red-500/30' : 'bg-slate-800/40 border-slate-700/60'}`}>
                                <Hourglass className={`w-3.5 h-3.5 ${isOverCapacity(task) ? 'text-red-400' : getDeadlineColor(task.deadline, task.startTime)}`} />
                                <div className="flex flex-col">
                                    <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Do termínu zbývá</span>
                                    <span className={`text-xs font-black uppercase tracking-tight ${isOverCapacity(task) ? 'text-red-400' : getDeadlineColor(task.deadline, task.startTime)}`}>
                                        {formatTimeLeft(task.deadline, task.startTime)}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {task.subTasks && task.subTasks.length > 0 && (
                <div className="space-y-2 mb-6 ml-11">
                    {task.subTasks.slice(0, 3).map(st => (
                        <button key={st.id} onClick={() => toggleSubtask(task, st.id)} className="flex items-center gap-2 group/st w-full">
                            <div className={`w-4 h-4 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${st.completed ? 'bg-indigo-600 border-indigo-600' : 'border-slate-700 group-hover/st:border-indigo-500'}`}>
                                {st.completed && <CheckCircle2 className="w-3 h-3 text-white" />}
                            </div>
                            <span className={`text-sm font-bold ${st.completed ? 'text-slate-600 line-through' : 'text-slate-400 group-hover/st:text-slate-200'}`}>{st.title}</span>
                        </button>
                    ))}
                    {task.subTasks.length > 3 && (
                        <div className="text-xs text-slate-600 font-bold uppercase">+ {task.subTasks.length - 3} dalších</div>
                    )}
                </div>
            )}

            {task.status === 'pending' && (task.type === 'task' || task.type === 'meeting') && (
                <div className="mb-8 ml-11">
                    <div className="flex justify-between items-end mb-1.5 px-0.5">
                        <span className="text-sm font-black text-slate-600 uppercase tracking-widest">Stav plnění</span>
                        <span className="text-xs font-black text-white">{task.progress || 0}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <motion.div initial={{ width: 0 }} animate={{ width: `${task.progress || 0}%` }} className={`h-full ${task.type === 'meeting' ? 'bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.4)]' : 'bg-indigo-600 shadow-[0_0_10px_rgba(79,70,229,0.4)]'}`} />
                    </div>
                </div>
            )}

            <div className="flex gap-2 pt-3 border-t border-slate-800/50 mt-auto">
                <button
                    onClick={async () => handleToggleTask(task)}
                    className={`h-9 px-4 flex-1 rounded-lg text-xs font-black uppercase transition-all flex items-center justify-center gap-2 ${task.status === 'completed' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                    {task.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5" /> : null}
                    {task.status === 'completed' ? 'Hotovo' : 'Splnit'}
                </button>
                <button onClick={() => setEditingTask(task)} className="h-9 px-4 flex-1 rounded-lg bg-slate-800/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 text-xs font-black uppercase transition-all flex items-center justify-center gap-2">
                    <FileText className="w-3.5 h-3.5" /> Detaily
                </button>
                {!task.isGoogleTask && (
                    <button
                        onClick={() => {
                            if (activeVoiceUpdateId === task.id) {
                                stopRecording();
                            } else {
                                setActiveVoiceUpdateId(task.id!);
                                activeVoiceUpdateIdRef.current = task.id!;
                                startRecording({
                                    enableFeedback: true,
                                    onSilence: () => stopRecording(),
                                    silenceThreshold: -45,
                                    silenceDuration: 4000
                                });
                            }
                        }}
                        className={`h-9 px-3 rounded-lg transition-all border ${activeVoiceUpdateId === task.id ? 'bg-red-500 border-red-500 text-white' : 'bg-orange-600/10 border-orange-500/20 text-orange-500 hover:bg-orange-600/20'}`}
                    >
                        <Mic className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </motion.div>
    );
}
