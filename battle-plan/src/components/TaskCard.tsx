import { motion } from 'framer-motion';
import { AlertCircle, Mail, Clock, Users, Lightbulb, CheckCircle2, Hourglass, Mic, FileText, Trash2 } from 'lucide-react';
import type { UnifiedTask } from '../types';
import { getTaskCompletionClasses, getTaskVisualTone, type TaskVisualTone } from '../utils/taskListPresentation';

const toneStyles: Record<TaskVisualTone, { accent: string; label: string }> = {
    task: { accent: 'rgb(99 102 241)', label: 'Úkol' },
    meeting: { accent: 'rgb(249 115 22)', label: 'Schůzka' },
    completed: { accent: 'rgb(16 185 129)', label: 'Splněno' },
    danger: { accent: 'rgb(239 68 68)', label: 'Nedostatek kapacity' },
};

interface TaskCardProps {
    task: UnifiedTask;
    useCompletedTaskTreatment?: boolean;
    activeVoiceUpdateId: number | null;
    isOverCapacity: (task: UnifiedTask) => boolean;
    getUrgencyColor: (urgency: number | undefined) => string;
    handleExport: (task: UnifiedTask) => void;
    handleDeleteTask: (task: UnifiedTask) => void;
    getDeadlineColor: (date?: string, time?: string) => string;
    formatTimeLeft: (date?: string, time?: string) => string;
    toggleSubtask: (task: UnifiedTask, subtaskId: string) => void;
    handleToggleTask: (task: UnifiedTask) => Promise<UnifiedTask | null>;
    setEditingTask: (task: UnifiedTask) => void;
    stopRecording: () => void;
    setActiveVoiceUpdateId: (id: number) => void;
    activeVoiceUpdateIdRef: React.MutableRefObject<number | null>;
    startRecording: (options: { enableFeedback?: boolean; onSilence?: () => void; silenceThreshold?: number; silenceDuration?: number }) => void | Promise<void>;
}

export function TaskCard({
    task,
    useCompletedTaskTreatment = false,
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
    const isCompleted = task.status === 'completed';
    const completionClasses = getTaskCompletionClasses(isCompleted, useCompletedTaskTreatment);
    const overCapacity = isOverCapacity(task);
    const visualTone = getTaskVisualTone(task, overCapacity);

    return (
        <motion.article
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.985 }}
            transition={{ layout: { type: 'spring', stiffness: 420, damping: 36, mass: 0.7 }, opacity: { duration: 0.18 } }}
            style={{ '--task-accent': toneStyles[visualTone].accent } as React.CSSProperties}
            className={`office-card task-card group relative flex min-w-0 flex-col overflow-clip ${completionClasses.card} ${overCapacity ? 'task-card-danger' : ''}`}
        >
            <span className="sr-only">{toneStyles[visualTone].label}</span>
            <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className={`text-xs font-semibold px-2 py-0.5 rounded border ${getUrgencyColor(task.urgency)}`}>
                        {task.isGoogleTask ? 'Google Task' : task.urgency === 3 ? 'Vysoká priorita' : task.urgency === 1 ? 'Nízká priorita' : task.type === 'meeting' ? 'Schůzka' : task.type === 'thought' || task.type === 'note' ? 'Myšlenka' : 'Úkol'}
                    </div>
                    {task.isGoogleTask && (
                        <div className="w-4 h-4 bg-blue-600 rounded flex items-center justify-center text-xs font-black text-on-accent shadow-sm">G</div>
                    )}
                    {overCapacity && (
                        <div className="task-warning flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1">
                            <AlertCircle className="h-3 w-3 shrink-0" />
                            <span className="truncate text-[11px] font-semibold">Prověřit kapacitu</span>
                        </div>
                    )}
                    {task.startTime && (
                        <div className="task-time-badge flex h-7 items-center gap-1.5 rounded-lg border px-2">
                            <Clock className="h-3 w-3 text-indigo-400" />
                            <span className="text-xs font-semibold">{task.startTime}</span>
                        </div>
                    )}
                </div>
                <button type="button" aria-label={`Sdílet e-mailem: ${task.title}`} onClick={(e) => { e.stopPropagation(); handleExport(task); }} className="surface-action min-h-11 shrink-0 gap-2 bg-slate-800/60 px-3 text-xs text-slate-400 hover:border-indigo-500/40 hover:text-white"><Mail className="h-4 w-4" />Sdílet e-mailem</button>
            </div>

            <div className="mb-3">
                <div className="flex items-start gap-3">
                    <div className={`mt-0.5 p-2 rounded-lg ${task.type === 'meeting' ? 'bg-orange-500/10 text-orange-400' : task.type === 'thought' ? 'bg-yellow-500/10 text-yellow-400' : 'bg-indigo-500/10 text-indigo-400'}`}>
                        {task.type === 'meeting' ? <Users className="w-4 h-4" /> : task.type === 'thought' ? <Lightbulb className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className={`task-title mb-1 transition-colors ${completionClasses.title}`}><button type="button" onClick={() => setEditingTask(task)}>{task.title}</button></h3>
                        <p className="text-sm text-slate-400 line-clamp-2 leading-relaxed mb-2">{task.description}</p>

                        {task.type === 'task' && task.deadline && (
                            <div className={`task-deadline mt-2 flex min-w-0 flex-wrap items-center gap-2 p-2 rounded-lg border ${overCapacity ? 'task-deadline-danger' : ''}`}>
                                <Hourglass className={`w-3.5 h-3.5 ${overCapacity ? 'text-red-400' : getDeadlineColor(task.deadline, task.startTime)}`} />
                                <div className="flex flex-col">
                                    <span className="text-[11px] text-slate-500">Do termínu</span>
                                    <span className={`text-xs font-semibold ${overCapacity ? 'text-red-400' : getDeadlineColor(task.deadline, task.startTime)}`}>
                                        {formatTimeLeft(task.deadline, task.startTime)}
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {task.subTasks && task.subTasks.length > 0 && (
                <div className="space-y-1 mb-3 ml-11">
                    {task.subTasks.slice(0, 3).map(st => (
                        <button key={st.id} onClick={() => toggleSubtask(task, st.id)} aria-pressed={st.completed} className="flex min-h-9 items-center gap-2 group/st w-full text-left">
                            <div className={`w-4 h-4 rounded-md border-2 flex items-center justify-center shrink-0 transition-[background-color,border-color] ${st.completed ? 'bg-indigo-600 border-indigo-600' : 'border-slate-700 group-hover/st:border-indigo-500'}`}>
                                {st.completed && <CheckCircle2 className="w-3 h-3 text-on-accent" />}
                            </div>
                            <span className={`text-sm font-bold ${st.completed ? 'text-slate-600 line-through' : 'text-slate-400 group-hover/st:text-slate-200'}`}>{st.title}</span>
                        </button>
                    ))}
                    {task.subTasks.length > 3 && (
                        <div className="text-xs text-slate-600 font-bold uppercase">+ {task.subTasks.length - 3} dalších</div>
                    )}
                </div>
            )}

            {task.status === 'pending' && (task.type === 'task' || task.type === 'meeting') && (task.progress ?? 0) > 0 && (
                <div className="mb-4 ml-11">
                    <div className="flex justify-between items-end mb-1.5 px-0.5">
                        <span className="text-xs text-slate-500">Dokončeno</span>
                        <span className="text-xs font-black text-white">{task.progress || 0}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <motion.div initial={{ width: 0 }} animate={{ width: `${task.progress || 0}%` }} className={`h-full ${task.type === 'meeting' ? 'bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.4)]' : 'bg-indigo-600 shadow-[0_0_10px_rgba(79,70,229,0.4)]'}`} />
                    </div>
                </div>
            )}

            <div className="task-action-rail mt-auto border-t border-slate-800/50 pt-3">
                <button
                    onClick={async () => handleToggleTask(task)}
                    className={`surface-action h-11 min-w-0 gap-2 px-2 text-xs ${isCompleted ? 'border-emerald-500/40 bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                    {isCompleted ? <CheckCircle2 className="w-3.5 h-3.5" /> : null}
                    {isCompleted ? 'Hotovo' : 'Splnit'}
                </button>
                <button onClick={() => setEditingTask(task)} className="surface-action h-11 min-w-0 gap-2 bg-slate-800/50 px-2 text-xs text-slate-300 hover:bg-slate-700 hover:text-white">
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
                                void Promise.resolve(startRecording({
                                    enableFeedback: true,
                                    onSilence: () => stopRecording(),
                                    silenceThreshold: -45,
                                    silenceDuration: 4000
                                })).catch((err: unknown) => {
                                    console.error('Task voice recording failed', err);
                                });
                            }
                        }}
                        aria-label={activeVoiceUpdateId === task.id ? `Zastavit diktování pro ${task.title}` : `Diktovat aktualizaci pro ${task.title}`}
                        className={`surface-action h-11 ${activeVoiceUpdateId === task.id ? 'bg-red-500 border-red-500 text-white' : 'bg-orange-600/10 border-orange-500/20 text-orange-400 hover:bg-orange-600/20'}`}
                    >
                        <Mic className="w-3.5 h-3.5" />
                    </button>
                )}
                <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteTask(task); }}
                    aria-label={`Smazat ${task.title}`}
                    className="surface-action h-11 bg-transparent text-slate-500 hover:border-red-500/40 hover:text-red-400"
                    title="Smazat"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            </div>
        </motion.article>
    );
}
