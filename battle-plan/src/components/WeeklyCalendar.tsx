import React, { useRef, useState } from 'react';
import { CheckCircle2, Clock, Hourglass, Sun } from 'lucide-react';
import type { UnifiedTask } from '../types';
import {
    formatTimeLeft,
    getDeadlineColor,
    getTimePosition,
    getWeekDays,
    getWeeklyReschedulePatch,
    isAllDayTask,
    isOverCapacity,
    type WeeklyDropTarget,
    type WeeklySchedulePatch,
} from '../utils/calendarUtils';

interface WeeklyCalendarProps {
    weekOffset: number;
    tasks: UnifiedTask[];
    rowHeight: number;
    calendarHours: number[];
    currentTime: Date;
    currentHourPosition: number;
    setEditingTask: (task: UnifiedTask) => void;
    onRescheduleTask: (task: UnifiedTask, patch: WeeklySchedulePatch) => Promise<boolean>;
}

type DragState = {
    task: UnifiedTask;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
};

const ALL_DAY_LANE_HEIGHT = 32;
const ALL_DAY_VISIBLE_ROWS = 3;
const DRAG_THRESHOLD = 8;

const taskKey = (task: UnifiedTask) => task.isGoogleTask ? `g-${task.googleId}` : `l-${task.id}`;

export const WeeklyCalendar: React.FC<WeeklyCalendarProps> = ({
    weekOffset,
    tasks,
    rowHeight,
    calendarHours,
    currentTime,
    currentHourPosition,
    setEditingTask,
    onRescheduleTask,
}) => {
    const days = getWeekDays(weekOffset);
    const startHour = calendarHours[0] ?? 7;
    const allDayCounts = days.map(day => tasks.filter(task => (
        (task.type === 'task' ? task.deadline : task.date) === day.full && isAllDayTask(task)
    )).length);
    const allDayLaneHeight = Math.max(ALL_DAY_LANE_HEIGHT, Math.min(Math.max(...allDayCounts), ALL_DAY_VISIBLE_ROWS) * ALL_DAY_LANE_HEIGHT);
    const timelineTop = 40 + allDayLaneHeight;
    const dragRef = useRef<DragState | null>(null);
    const suppressClickRef = useRef<string | null>(null);
    const [dropTarget, setDropTarget] = useState<WeeklyDropTarget | null>(null);
    const [busyTask, setBusyTask] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState('');

    const targetAtPoint = (task: UnifiedTask, x: number, y: number): WeeklyDropTarget | null => {
        const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-week-drop-lane]');
        if (!element) return null;
        const lane = element.dataset.weekDropLane as WeeklyDropTarget['lane'];
        const date = element.dataset.weekDate;
        if (!date || (lane !== 'all-day' && lane !== 'timed')) return null;

        const originalLane = isAllDayTask(task) ? 'all-day' : 'timed';
        if (lane !== originalLane || (task.isGoogleTask && lane !== 'all-day')) return null;
        if (lane === 'all-day') return { date, lane };

        const rect = element.getBoundingClientRect();
        return {
            date,
            lane,
            blockTopMinutes: startHour * 60 + ((y - rect.top) / rowHeight) * 60,
        };
    };

    const describeTarget = (task: UnifiedTask, target: WeeklyDropTarget) => {
        const patch = getWeeklyReschedulePatch(task, target);
        const date = new Date(`${target.date}T12:00:00`).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' });
        return target.lane === 'all-day' ? `${date}, celý den` : `${date}, ${patch.startTime}`;
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>, task: UnifiedTask) => {
        if (busyTask || event.button !== 0) return;
        dragRef.current = { task, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (!drag.dragging && distance < DRAG_THRESHOLD) return;
        if (!drag.dragging) {
            drag.dragging = true;
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        const target = targetAtPoint(drag.task, event.clientX, event.clientY);
        setDropTarget(target);
        setAnnouncement(target ? `Přesun na ${describeTarget(drag.task, target)}` : 'Mimo platnou oblast');
    };

    const finishDrag = async (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        if (!drag.dragging) return;
        suppressClickRef.current = taskKey(drag.task);
        const target = targetAtPoint(drag.task, event.clientX, event.clientY);
        setDropTarget(null);
        if (!target) {
            setAnnouncement('Přesun zrušen');
            return;
        }
        const key = taskKey(drag.task);
        setBusyTask(key);
        const patch = getWeeklyReschedulePatch(drag.task, target);
        try {
            const saved = await onRescheduleTask(drag.task, patch);
            setAnnouncement(saved ? `Přesunuto na ${describeTarget(drag.task, target)}` : 'Přesun se nepodařilo uložit');
        } catch (error) {
            console.error('Weekly reschedule failed', error);
            setAnnouncement('Přesun se nepodařilo uložit');
        } finally {
            setBusyTask(null);
        }
    };

    const cancelDrag = () => {
        if (dragRef.current?.dragging) suppressClickRef.current = taskKey(dragRef.current.task);
        dragRef.current = null;
        setDropTarget(null);
        setAnnouncement('Přesun zrušen');
    };

    const openTask = (task: UnifiedTask) => {
        const key = taskKey(task);
        if (suppressClickRef.current === key) {
            suppressClickRef.current = null;
            return;
        }
        setEditingTask(task);
    };

    const pointerProps = (task: UnifiedTask) => ({
        onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => handlePointerDown(event, task),
        onPointerMove: handlePointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: cancelDrag,
        onClick: () => openTask(task),
        'aria-busy': busyTask === taskKey(task),
    });

    return (
        <div className="flex-1 flex flex-col min-h-0">
            <div aria-live="polite" className="sr-only">{announcement}</div>
            <div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar relative">
                <div className="grid grid-cols-[60px_repeat(7,1fr)] min-w-[700px] md:min-w-[1200px] relative" style={{ height: `${calendarHours.length * rowHeight + timelineTop + 20}px` }}>
                    <div className="relative border-r border-white/10 bg-slate-950/40 z-20 ml-6 md:ml-10">
                        {calendarHours.map(hour => (
                            <div key={hour} className="absolute left-0 w-full flex items-center justify-center -translate-y-1/2" style={{ top: `${(hour - startHour) * rowHeight + timelineTop}px`, height: '20px' }}>
                                <span className="text-xs font-black text-slate-400 tabular-nums">{String(hour).padStart(2, '0')}:00</span>
                            </div>
                        ))}
                    </div>

                    {days.map(day => {
                        const matchesDay = (task: UnifiedTask) => (task.type === 'task' ? task.deadline : task.date) === day.full;
                        const allDayTasks = tasks.filter(task => matchesDay(task) && isAllDayTask(task));
                        const timedTasks = tasks.filter(task => matchesDay(task) && !isAllDayTask(task));
                        const isAllDayTarget = dropTarget?.date === day.full && dropTarget.lane === 'all-day';
                        const isTimedTarget = dropTarget?.date === day.full && dropTarget.lane === 'timed';

                        return (
                            <div key={day.full} className={`relative border-r border-white/10 last:border-r-0 ${day.isToday ? 'bg-indigo-500/5' : day.isWeekend ? 'bg-amber-950/20' : ''}`}>
                                <div className={`sticky top-0 left-0 w-full h-10 border-b border-white/10 flex flex-col items-center justify-center backdrop-blur-md z-30 ${day.isToday ? 'bg-indigo-600/25' : day.isWeekend ? 'bg-amber-900/40' : 'bg-slate-900/60'}`}>
                                    <span className={`text-xs uppercase font-black tracking-widest ${day.isToday ? 'text-indigo-300' : 'text-slate-400'}`}>{day.dayName}</span>
                                    <span className={`text-sm font-black leading-none ${day.isToday ? 'text-white' : 'text-slate-200'}`}>{day.dayNum}</span>
                                </div>

                                <div
                                    data-week-drop-lane="all-day"
                                    data-week-date={day.full}
                                    className={`absolute left-0 right-0 z-20 px-1 pt-1 space-y-1 overflow-y-auto no-scrollbar transition-colors ${isAllDayTarget ? 'bg-emerald-500/20 ring-2 ring-inset ring-emerald-400' : ''}`}
                                    style={{ top: '40px', height: `${allDayLaneHeight}px` }}
                                >
                                    {allDayTasks.map(task => {
                                        const completed = task.status === 'completed';
                                        return (
                                            <button key={`${taskKey(task)}-allday`} {...pointerProps(task)} disabled={busyTask === taskKey(task)} className={`w-full px-2 py-1 rounded-md border transition-all flex items-center gap-1.5 overflow-hidden touch-pan-y ${completed ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-200' : task.type === 'meeting' ? 'bg-indigo-600/80 border-indigo-500/50 hover:border-indigo-300' : 'bg-amber-600/80 border-amber-500/50 hover:border-amber-300'} disabled:opacity-60`}>
                                                {completed ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <Sun className="w-3 h-3 text-white shrink-0" />}
                                                <span className={`text-sm font-bold uppercase tracking-tight line-clamp-1 leading-tight ${completed ? 'line-through text-emerald-200' : 'text-white'}`}>{task.title}</span>
                                                {completed && <span className="text-[9px] font-black uppercase ml-auto">Splněno</span>}
                                                {task.isGoogleTask && <span className="text-sm bg-blue-500/30 text-blue-200 px-1 rounded-sm border border-blue-400/30 shrink-0">G</span>}
                                            </button>
                                        );
                                    })}
                                </div>

                                {calendarHours.map(hour => <div key={hour} className="absolute left-0 w-full border-b border-white/5" style={{ top: `${(hour - startHour) * rowHeight + timelineTop}px`, height: `${rowHeight}px` }} />)}

                                <div data-week-drop-lane="timed" data-week-date={day.full} className={`absolute left-1 right-1 bottom-0 z-10 transition-colors ${isTimedTarget ? 'bg-emerald-500/10 ring-2 ring-inset ring-emerald-400/70' : ''}`} style={{ top: `${timelineTop}px` }}>
                                    {timedTasks.map(task => {
                                        const completed = task.status === 'completed';
                                        const height = Math.max(40, (task.duration || 60) / 60 * rowHeight);
                                        const basePos = getTimePosition(task.startTime, rowHeight);
                                        const top = task.type === 'task' ? basePos - height : basePos;
                                        return (
                                            <button key={taskKey(task)} {...pointerProps(task)} disabled={busyTask === taskKey(task)} className={`absolute left-0 right-0 p-2 rounded-lg border transition-all flex flex-col gap-0.5 overflow-hidden group/item touch-pan-y ${completed ? 'bg-emerald-950/80 border-emerald-500/40' : task.type === 'meeting' ? 'bg-indigo-600 border-indigo-500/50 hover:border-indigo-400' : isOverCapacity(currentTime, task) ? 'bg-red-950/40 border-red-500/40 animate-pulse-red' : 'bg-slate-800/90 border-slate-700/60 hover:border-slate-500'} disabled:opacity-60`} style={{ top: `${top}px`, height: `${height}px` }}>
                                                <div className={`absolute top-0 left-0 bottom-0 w-1 ${completed ? 'bg-emerald-400' : task.type === 'meeting' ? 'bg-indigo-300' : isOverCapacity(currentTime, task) ? 'bg-red-500' : 'bg-orange-500'} opacity-80`} />
                                                <div className="flex items-center justify-between gap-1">
                                                    <span className={`text-xs font-black uppercase tracking-tight line-clamp-1 leading-tight ${completed ? 'line-through text-emerald-200' : 'text-white'}`}>{task.title}</span>
                                                    {completed && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300 shrink-0" />}
                                                    {task.isGoogleTask && <span className="text-sm bg-blue-500/20 text-blue-400 px-1 rounded-sm border border-blue-500/30 shrink-0">G</span>}
                                                </div>
                                                {completed ? <span className="text-[9px] font-black uppercase text-emerald-300 mt-auto">Splněno</span> : (
                                                    <div className="flex flex-col gap-1 mt-auto">
                                                        {task.startTime && <div className="flex items-center gap-1 opacity-60"><Clock className="w-2.5 h-2.5 text-slate-400" /><span className="text-sm font-bold text-slate-400">{task.startTime} {task.duration ? `(${task.duration}m)` : ''}</span></div>}
                                                        {task.type === 'task' && task.deadline && <div className="flex items-center gap-1 opacity-90"><Hourglass className={`w-2.5 h-2.5 ${isOverCapacity(currentTime, task) ? 'text-red-400' : getDeadlineColor(currentTime, task.deadline, task.startTime)}`} /><span className={`text-xs font-black uppercase tracking-tight ${isOverCapacity(currentTime, task) ? 'text-red-400' : getDeadlineColor(currentTime, task.deadline, task.startTime)}`}>{formatTimeLeft(currentTime, task.deadline, task.startTime)}</span></div>}
                                                    </div>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>

                                {day.isToday && currentHourPosition !== -1 && <div className="absolute left-0 right-0 z-30 flex items-center pointer-events-none" style={{ top: `${currentHourPosition + timelineTop}px` }}><div className="w-2 h-2 rounded-full bg-red-500 -ml-1" /><div className="flex-1 h-px bg-red-500" /></div>}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
