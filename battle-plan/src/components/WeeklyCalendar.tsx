import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Clock, GripVertical, Hourglass, MapPin, Sun } from 'lucide-react';
import type { UnifiedTask } from '../types';
import {
    formatTimeLeft,
    getDeadlineColor,
    getTimePosition,
    getWeekDays,
    getWeeklyReschedulePatch,
    isWeeklyScheduleNoop,
    isAllDayTask,
    isOverCapacity,
    snapWeeklyMinute,
    type WeeklyDropTarget,
    type WeeklySchedulePatch,
} from '../utils/calendarUtils';
import { getCalendarDensity, getWeeklyVisualInterval, layoutCalendarIntervals } from '../utils/weeklyCalendarLayout';

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

type DropLaneGeometry = {
    date: string;
    lane: WeeklyDropTarget['lane'];
    left: number;
    right: number;
    top: number;
    bottom: number;
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
    const startHour = calendarHours[0] ?? 7;
    const [expandedAllDay, setExpandedAllDay] = useState<string | null>(null);
    const [expandedCollision, setExpandedCollision] = useState<string | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const suppressClickRef = useRef<string | null>(null);
    const lastTargetKeyRef = useRef<string | null>(null);
    const ghostRef = useRef<HTMLDivElement | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
    const collisionTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const dropLaneGeometryRef = useRef<{ lanes: DropLaneGeometry[]; scrollLeft: number; scrollTop: number } | null>(null);
    const calendarRef = useRef<HTMLDivElement | null>(null);
    const [dropTarget, setDropTarget] = useState<WeeklyDropTarget | null>(null);
    const [draggingTask, setDraggingTask] = useState<UnifiedTask | null>(null);
    const [busyTask, setBusyTask] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState('');
    const [dayWidth, setDayWidth] = useState(160);
    const days = useMemo(() => getWeekDays(weekOffset), [weekOffset]);
    const tasksByKey = useMemo(() => new Map(tasks.map(task => [taskKey(task), task])), [tasks]);
    const dayDataByDate = useMemo(() => {
        const buckets = new Map(days.map(day => [day.full, { allDayTasks: [] as UnifiedTask[], timedTasks: [] as UnifiedTask[] }]));
        for (const task of tasks) {
            const date = task.type === 'task' ? task.deadline : task.date;
            const bucket = date ? buckets.get(date) : undefined;
            if (!bucket) continue;
            (isAllDayTask(task) ? bucket.allDayTasks : bucket.timedTasks).push(task);
        }
        return new Map(Array.from(buckets, ([date, bucket]) => [date, {
            ...bucket,
            timedLayout: new Map(layoutCalendarIntervals(bucket.timedTasks.map(getWeeklyVisualInterval), dayWidth).map(item => [item.id, item])),
        }]));
    }, [dayWidth, days, tasks]);
    const allDayCounts = days.map(day => dayDataByDate.get(day.full)?.allDayTasks.length ?? 0);
    const expandedCount = expandedAllDay ? dayDataByDate.get(expandedAllDay)?.allDayTasks.length ?? 0 : 0;
    const allDayLaneHeight = Math.max(ALL_DAY_LANE_HEIGHT, Math.max(Math.min(Math.max(...allDayCounts), ALL_DAY_VISIBLE_ROWS), expandedCount) * ALL_DAY_LANE_HEIGHT);
    const timelineTop = 40 + allDayLaneHeight;

    const resetDragState = useCallback((message?: string) => {
        const drag = dragRef.current;
        if (drag && drag.pointerId !== -1) {
            const source = document.querySelector<HTMLElement>(`[data-task-key="${taskKey(drag.task)}"]`);
            if (source?.hasPointerCapture(drag.pointerId)) source.releasePointerCapture(drag.pointerId);
        }
        dragRef.current = null;
        pointerPositionRef.current = null;
        dropLaneGeometryRef.current = null;
        lastTargetKeyRef.current = null;
        if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
        setDropTarget(null);
        setDraggingTask(null);
        if (message) setAnnouncement(message);
    }, []);

    useEffect(() => {
        const calendar = calendarRef.current;
        if (!calendar || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => {
            const nextWidth = Math.max(112, (entry.contentRect.width - 60) / 7);
            setDayWidth(nextWidth);
            if (dragRef.current?.dragging) {
                resetDragState('Přesun zrušen kvůli změně rozvržení');
            }
        });
        observer.observe(calendar);
        return () => observer.disconnect();
    }, [resetDragState]);

    const captureDropLaneGeometry = () => {
        const calendar = calendarRef.current;
        if (!calendar) return null;
        const lanes = Array.from(calendar.querySelectorAll<HTMLElement>('[data-week-drop-lane]')).flatMap((element): DropLaneGeometry[] => {
            const lane = element.dataset.weekDropLane as WeeklyDropTarget['lane'];
            const date = element.dataset.weekDate;
            if (!date || (lane !== 'all-day' && lane !== 'timed')) return [];
            const rect = element.getBoundingClientRect();
            return [{ date, lane, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
        });
        return { lanes, scrollLeft: calendar.scrollLeft, scrollTop: calendar.scrollTop };
    };

    const targetAtPoint = (task: UnifiedTask, x: number, y: number): WeeklyDropTarget | null => {
        const geometry = dropLaneGeometryRef.current;
        const calendar = calendarRef.current;
        if (!geometry || !calendar) return null;
        const deltaX = calendar.scrollLeft - geometry.scrollLeft;
        const deltaY = calendar.scrollTop - geometry.scrollTop;
        const matched = geometry.lanes.find(item => (
            x >= item.left - deltaX && x <= item.right - deltaX
            && y >= item.top - deltaY && y <= item.bottom - deltaY
        ));
        if (!matched) return null;
        const { lane, date } = matched;

        const originalLane = isAllDayTask(task) ? 'all-day' : 'timed';
        if (lane !== originalLane || (task.isGoogleTask && lane !== 'all-day')) return null;
        if (lane === 'all-day') return { date, lane };

        return {
            date,
            lane,
            blockTopMinutes: startHour * 60 + ((y - (matched.top - deltaY)) / rowHeight) * 60,
        };
    };

    const describeTarget = (task: UnifiedTask, target: WeeklyDropTarget) => {
        const patch = getWeeklyReschedulePatch(task, target);
        const date = new Date(`${target.date}T12:00:00`).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' });
        return target.lane === 'all-day' ? `${date}, celý den` : `${date}, ${patch.startTime}`;
    };

    const targetKey = (target: WeeklyDropTarget | null) => target
        ? `${target.lane}|${target.date}|${target.lane === 'timed' ? snapWeeklyMinute(target.blockTopMinutes ?? startHour * 60) : 'all'}`
        : 'invalid';

    const publishTarget = (task: UnifiedTask, target: WeeklyDropTarget | null) => {
        const nextKey = targetKey(target);
        if (lastTargetKeyRef.current === nextKey) return;
        lastTargetKeyRef.current = nextKey;
        setDropTarget(target);
        setAnnouncement(target ? `Přesun na ${describeTarget(task, target)}` : 'Mimo platnou oblast');
    };

    const schedulePointerFrame = (x: number, y: number) => {
        pointerPositionRef.current = { x, y };
        if (animationFrameRef.current !== null) return;
        animationFrameRef.current = requestAnimationFrame(() => {
            animationFrameRef.current = null;
            const point = pointerPositionRef.current;
            const drag = dragRef.current;
            if (!point || !drag?.dragging) return;
            if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${point.x + 14}px, ${point.y + 14}px, 0)`;
            publishTarget(drag.task, targetAtPoint(drag.task, point.x, point.y));
        });
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>, task: UnifiedTask) => {
        if (busyTask || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dropLaneGeometryRef.current = captureDropLaneGeometry();
        dragRef.current = { task, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (!drag.dragging && distance < DRAG_THRESHOLD) return;
        if (!drag.dragging) {
            drag.dragging = true;
            setDraggingTask(drag.task);
        }
        event.preventDefault();
        schedulePointerFrame(event.clientX, event.clientY);
    };

    const commitDrop = async (task: UnifiedTask, target: WeeklyDropTarget | null) => {
        if (!target) {
            resetDragState('Přesun zrušen');
            return;
        }
        const patch = getWeeklyReschedulePatch(task, target);
        if (isWeeklyScheduleNoop(task, patch)) {
            resetDragState('Položka zůstala na původním místě');
            return;
        }
        const key = taskKey(task);
        resetDragState();
        setBusyTask(key);
        try {
            const saved = await onRescheduleTask(task, patch);
            setAnnouncement(saved ? `Přesunuto na ${describeTarget(task, target)}` : 'Přesun se nepodařilo uložit');
        } catch (error) {
            console.error('Weekly reschedule failed', error);
            setAnnouncement('Přesun se nepodařilo uložit');
        } finally {
            setBusyTask(null);
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-key="${key}"]`)?.focus());
        }
    };

    const finishDrag = async (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        if (!drag.dragging) return;
        suppressClickRef.current = taskKey(drag.task);
        const target = targetAtPoint(drag.task, event.clientX, event.clientY);
        requestAnimationFrame(() => { suppressClickRef.current = null; });
        await commitDrop(drag.task, target);
    };

    const cancelDrag = useCallback(() => {
        if (dragRef.current?.dragging) suppressClickRef.current = taskKey(dragRef.current.task);
        resetDragState('Přesun zrušen');
    }, [resetDragState]);

    useEffect(() => {
        const handleBlur = () => { if (dragRef.current) cancelDrag(); };
        const handleVisibility = () => { if (document.hidden && dragRef.current) cancelDrag(); };
        window.addEventListener('blur', handleBlur);
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            window.removeEventListener('blur', handleBlur);
            document.removeEventListener('visibilitychange', handleVisibility);
            resetDragState();
        };
    }, [cancelDrag, resetDragState, weekOffset]);

    const keyboardTargetFor = (task: UnifiedTask): WeeklyDropTarget => {
        const interval = getWeeklyVisualInterval(task);
        return isAllDayTask(task)
            ? { date: task.type === 'task' ? task.deadline! : task.date!, lane: 'all-day' }
            : { date: task.type === 'task' ? task.deadline! : task.date!, lane: 'timed', blockTopMinutes: interval.startMinute };
    };

    const handleKeyDown = async (event: React.KeyboardEvent<HTMLButtonElement>, task: UnifiedTask) => {
        const active = dragRef.current?.pointerId === -1 && taskKey(dragRef.current.task) === taskKey(task);
        if (!active && event.key !== ' ') return;
        if (!active) {
            event.preventDefault();
            const initialTarget = keyboardTargetFor(task);
            dragRef.current = { task, pointerId: -1, startX: 0, startY: 0, dragging: true };
            setDraggingTask(task);
            publishTarget(task, initialTarget);
            return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Escape') return cancelDrag();
        if (event.key === 'Enter' || event.key === ' ') return void commitDrop(task, dropTarget);
        const current = dropTarget ?? keyboardTargetFor(task);
        const date = new Date(`${current.date}T12:00:00`);
        if (event.key === 'ArrowLeft') date.setDate(date.getDate() - 1);
        if (event.key === 'ArrowRight') date.setDate(date.getDate() + 1);
        const dateValue = date.toISOString().slice(0, 10);
        const blockTopMinutes = current.lane === 'timed'
            ? (current.blockTopMinutes ?? startHour * 60) + (event.key === 'ArrowUp' ? -15 : event.key === 'ArrowDown' ? 15 : 0)
            : undefined;
        publishTarget(task, { ...current, date: dateValue, blockTopMinutes });
    };

    const openTask = (task: UnifiedTask) => {
        const key = taskKey(task);
        if (suppressClickRef.current === key) {
            suppressClickRef.current = null;
            return;
        }
        setEditingTask(task);
    };

    const closeCollision = (collisionId: string) => {
        setExpandedCollision(null);
        requestAnimationFrame(() => collisionTriggerRefs.current.get(collisionId)?.focus());
    };

    const pointerProps = (task: UnifiedTask) => ({
        onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => handlePointerDown(event, task),
        onPointerMove: handlePointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: cancelDrag,
        onLostPointerCapture: () => { if (dragRef.current?.dragging) cancelDrag(); },
        onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => { void handleKeyDown(event, task); },
        onClick: () => openTask(task),
        'data-task-key': taskKey(task),
        'aria-busy': busyTask === taskKey(task),
        'aria-grabbed': draggingTask ? draggingTask === task : undefined,
    });

    const draggingKey = draggingTask ? taskKey(draggingTask) : null;
    const targetLabel = draggingTask && dropTarget ? describeTarget(draggingTask, dropTarget) : null;

    const renderDropPreview = (lane: WeeklyDropTarget['lane']) => {
        if (!draggingTask || !dropTarget || dropTarget.lane !== lane) return null;
        const completed = draggingTask.status === 'completed';
        const isMeeting = draggingTask.type === 'meeting';
        const duration = Math.max(0, draggingTask.duration || 60);
        const height = lane === 'timed' ? Math.max(40, duration / 60 * rowHeight) : 28;
        const topMinutes = lane === 'timed'
            ? snapWeeklyMinute(dropTarget.blockTopMinutes ?? startHour * 60, duration)
            : 0;
        const top = lane === 'timed' ? ((topMinutes - startHour * 60) / 60) * rowHeight : 2;

        return (
            <motion.div
                layoutId="weekly-drop-preview"
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.55 }}
                className={`absolute left-1 right-1 z-40 overflow-hidden rounded-lg border-2 border-dashed pointer-events-none shadow-[0_0_28px_rgba(52,211,153,0.28)] ${completed ? 'border-emerald-300 bg-emerald-950/90' : isMeeting ? 'border-indigo-300 bg-indigo-500/85' : 'border-amber-300 bg-slate-800/95'}`}
                style={{ top: `${top}px`, height: `${height}px` }}
                aria-hidden="true"
            >
                <div className="absolute inset-0 bg-gradient-to-br from-white/18 via-transparent to-emerald-300/10 animate-pulse" />
                <div className="relative flex h-full items-center gap-1.5 px-2">
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-emerald-200 drop-shadow" />
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[10px] font-black uppercase tracking-wide text-white">{draggingTask.title}</div>
                        {lane === 'timed' && <div className="text-[9px] font-bold tabular-nums text-emerald-100">{targetLabel}</div>}
                    </div>
                    <span className="shrink-0 rounded bg-emerald-300 px-1.5 py-0.5 text-[8px] font-black uppercase text-emerald-950">Sem</span>
                </div>
            </motion.div>
        );
    };

    return (
        <div className="flex-1 flex flex-col min-h-0">
            <div aria-live="polite" className="sr-only">{announcement}</div>
            <AnimatePresence>
                {draggingTask && (
                    <div key="weekly-drag-ghost" ref={ghostRef} className="pointer-events-none fixed left-0 top-0 z-[95] max-w-64 rounded-xl border border-indigo-400/50 bg-slate-900/95 px-3 py-2 shadow-2xl" aria-hidden="true">
                        <div className="truncate text-xs font-black uppercase text-white">{draggingTask.title}</div>
                        <div className="text-[10px] font-bold text-indigo-300">{targetLabel ?? 'Hledám platný cíl…'}</div>
                    </div>
                )}
                {draggingTask && (
                    <motion.div
                        initial={{ opacity: 0, y: 12, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.97 }}
                        transition={{ type: 'spring', stiffness: 460, damping: 32 }}
                        className={`fixed bottom-24 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-2 shadow-2xl backdrop-blur-xl md:bottom-8 ${dropTarget ? 'border-emerald-400/60 bg-emerald-950/90 text-emerald-100 shadow-emerald-950/60' : 'border-red-400/60 bg-red-950/90 text-red-100 shadow-red-950/60'}`}
                        role="status"
                    >
                        <MapPin className={`h-4 w-4 ${dropTarget ? 'text-emerald-300' : 'text-red-300'}`} />
                        <div className="whitespace-nowrap">
                            <div className="text-[9px] font-black uppercase tracking-[0.16em] opacity-70">{dropTarget ? 'Pustit a přesunout' : 'Mimo platnou oblast'}</div>
                            <div className="text-xs font-black first-letter:uppercase">{targetLabel ?? 'Vraťte kartu nad kalendář'}</div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
            <div ref={calendarRef} className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar relative" tabIndex={0} aria-label="Týdenní kalendář, vodorovně posuvný">
                <div className="grid grid-cols-[60px_repeat(7,1fr)] min-w-[844px] md:min-w-[1200px] relative" style={{ height: `${calendarHours.length * rowHeight + timelineTop + 20}px` }}>
                    <div className="relative border-r border-white/10 bg-slate-950/40 z-20 ml-6 md:ml-10">
                        {calendarHours.map(hour => (
                            <div key={hour} className="absolute left-0 w-full flex items-center justify-center -translate-y-1/2" style={{ top: `${(hour - startHour) * rowHeight + timelineTop}px`, height: '20px' }}>
                                <span className="text-xs font-black text-slate-400 tabular-nums">{String(hour).padStart(2, '0')}:00</span>
                            </div>
                        ))}
                    </div>

                    {days.map(day => {
                        const { allDayTasks, timedTasks, timedLayout } = dayDataByDate.get(day.full)!;
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
                                    {isAllDayTarget && renderDropPreview('all-day')}
                                    {(expandedAllDay === day.full ? allDayTasks : allDayTasks.slice(0, ALL_DAY_VISIBLE_ROWS)).map(task => {
                                        const completed = task.status === 'completed';
                                        const isDragging = draggingKey === taskKey(task);
                                        return (
                                            <button key={`${taskKey(task)}-allday`} {...pointerProps(task)} disabled={busyTask === taskKey(task)} className={`w-full px-2 py-1 rounded-md border transition-[opacity,transform,border-color,box-shadow] duration-150 flex items-center gap-1.5 overflow-hidden touch-pan-y cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-25 scale-[0.97] border-dashed shadow-none' : 'shadow-sm'} ${completed ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-200' : task.type === 'meeting' ? 'bg-indigo-600/80 border-indigo-500/50 hover:border-indigo-300' : 'bg-amber-600/80 border-amber-500/50 hover:border-amber-300'} disabled:opacity-60`}>
                                                {!completed && <GripVertical className="h-3 w-3 shrink-0 text-white/45" />}
                                                {completed ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <Sun className="w-3 h-3 text-white shrink-0" />}
                                                <span className={`text-sm font-bold uppercase tracking-tight line-clamp-1 leading-tight ${completed ? 'line-through text-emerald-200' : 'text-white'}`}>{task.title}</span>
                                                {completed && <span className="text-[9px] font-black uppercase ml-auto">Splněno</span>}
                                                {task.isGoogleTask && <span className="text-sm bg-blue-500/30 text-blue-200 px-1 rounded-sm border border-blue-400/30 shrink-0">G</span>}
                                            </button>
                                        );
                                    })}
                                    {allDayTasks.length > ALL_DAY_VISIBLE_ROWS && (
                                        <button type="button" onClick={() => setExpandedAllDay(current => current === day.full ? null : day.full)} className="surface-focus w-full rounded-md border border-dashed border-slate-600 bg-slate-900/90 px-2 py-1 text-xs font-black uppercase text-indigo-300">
                                            {expandedAllDay === day.full ? 'Sbalit' : `+${allDayTasks.length - ALL_DAY_VISIBLE_ROWS} dalších`}
                                        </button>
                                    )}
                                </div>

                                {calendarHours.map(hour => <div key={hour} className="absolute left-0 w-full border-b border-white/5" style={{ top: `${(hour - startHour) * rowHeight + timelineTop}px`, height: `${rowHeight}px` }} />)}

                                <div data-week-drop-lane="timed" data-week-date={day.full} className={`absolute left-1 right-1 bottom-0 z-10 transition-colors ${isTimedTarget ? 'bg-emerald-500/10 ring-2 ring-inset ring-emerald-400/70' : ''}`} style={{ top: `${timelineTop}px` }}>
                                    {isTimedTarget && renderDropPreview('timed')}
                                    {timedTasks.map(task => {
                                        const completed = task.status === 'completed';
                                        const isDragging = draggingKey === taskKey(task);
                                        const height = Math.max(40, (task.duration || 60) / 60 * rowHeight);
                                        const basePos = getTimePosition(task.startTime, rowHeight);
                                        const top = task.type === 'task' ? basePos - height : basePos;
                                        const layout = timedLayout.get(taskKey(task));
                                        if (!layout?.visible) return null;
                                        const density = getCalendarDensity(height);
                                        const left = `calc(${layout.column} * ((100% - ${(layout.columnCount - 1) * 4}px) / ${layout.columnCount} + 4px))`;
                                        const width = `calc((100% - ${(layout.columnCount - 1) * 4}px) / ${layout.columnCount})`;
                                        const collisionId = `${day.full}-${layout.id}`;
                                        const hiddenTasks = layout.hiddenIds.map(id => tasksByKey.get(id)).filter((item): item is UnifiedTask => Boolean(item));
                                        return (
                                            <div key={taskKey(task)} className="absolute" style={{ top: `${top}px`, height: `${height}px`, left, width }}>
                                                <button {...pointerProps(task)} disabled={busyTask === taskKey(task)} className={`relative flex h-full w-full flex-col gap-0.5 overflow-hidden rounded-lg border p-2 text-left transition-[opacity,transform,border-color,box-shadow] duration-150 group/item touch-pan-y cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-25 scale-[0.97] border-dashed shadow-none' : 'shadow-lg'} ${completed ? 'bg-emerald-950/80 border-emerald-500/40' : task.type === 'meeting' ? 'bg-indigo-600 border-indigo-500/50 hover:border-indigo-400' : isOverCapacity(currentTime, task) ? 'bg-red-950/40 border-red-500/40 animate-pulse-red' : 'bg-slate-800/90 border-slate-700/60 hover:border-slate-500'} disabled:opacity-60`}>
                                                    <div className={`absolute top-0 left-0 bottom-0 w-1 ${completed ? 'bg-emerald-400' : task.type === 'meeting' ? 'bg-indigo-300' : isOverCapacity(currentTime, task) ? 'bg-red-500' : 'bg-orange-500'} opacity-80`} />
                                                    <div className="flex items-center justify-between gap-1">
                                                        <span className="flex min-w-0 items-center gap-1">
                                                            {!completed && <GripVertical className="h-3 w-3 shrink-0 text-white/35" />}
                                                            <span className={`text-xs font-black uppercase tracking-tight line-clamp-1 leading-tight ${completed ? 'line-through text-emerald-200' : 'text-white'}`}>{task.title}</span>
                                                        </span>
                                                        {completed && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300 shrink-0" />}
                                                        {task.isGoogleTask && <span className="text-sm bg-blue-500/20 text-blue-400 px-1 rounded-sm border border-blue-500/30 shrink-0">G</span>}
                                                    </div>
                                                    {completed ? <span className="text-[9px] font-black uppercase text-emerald-300 mt-auto">Splněno</span> : density !== 'compact' ? (
                                                        <div className="flex flex-col gap-1 mt-auto">
                                                            {task.startTime && <div className="flex items-center gap-1 opacity-60"><Clock className="w-2.5 h-2.5 text-slate-400" /><span className="text-sm font-bold text-slate-400">{task.startTime} {task.duration ? `(${task.duration}m)` : ''}</span></div>}
                                                            {density === 'comfortable' && task.type === 'task' && task.deadline && <div className="flex items-center gap-1 opacity-90"><Hourglass className={`w-2.5 h-2.5 ${isOverCapacity(currentTime, task) ? 'text-red-400' : getDeadlineColor(currentTime, task.deadline, task.startTime)}`} /><span className={`text-xs font-black uppercase tracking-tight ${isOverCapacity(currentTime, task) ? 'text-red-400' : getDeadlineColor(currentTime, task.deadline, task.startTime)}`}>{formatTimeLeft(currentTime, task.deadline, task.startTime)}</span></div>}
                                                        </div>
                                                    ) : task.startTime ? <span className="mt-auto truncate text-[9px] font-bold text-slate-300">{task.startTime}</span> : null}
                                                </button>
                                                {layout.hiddenCount > 0 && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            ref={(element) => {
                                                                if (element) collisionTriggerRefs.current.set(collisionId, element);
                                                                else collisionTriggerRefs.current.delete(collisionId);
                                                            }}
                                                            className="surface-focus absolute right-1 top-1 z-20 min-h-7 min-w-7 rounded-md border border-indigo-400/30 bg-slate-950/90 px-1 text-[9px] font-black text-indigo-200 shadow-lg"
                                                            aria-expanded={expandedCollision === collisionId}
                                                            aria-controls={`${collisionId}-items`}
                                                            aria-label={`Zobrazit ${layout.hiddenCount} překrytých položek`}
                                                            onClick={() => setExpandedCollision(current => current === collisionId ? null : collisionId)}
                                                        >
                                                            +{layout.hiddenCount}
                                                        </button>
                                                        <AnimatePresence>
                                                            {expandedCollision === collisionId && (
                                                                <motion.div
                                                                    id={`${collisionId}-items`}
                                                                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                                                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                                                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                                                                    className="absolute right-1 top-9 z-30 min-w-48 space-y-1 rounded-xl border border-slate-700 bg-slate-950/95 p-2 shadow-2xl"
                                                                    onKeyDown={(event) => {
                                                                        if (event.key !== 'Escape') return;
                                                                        event.preventDefault();
                                                                        event.stopPropagation();
                                                                        closeCollision(collisionId);
                                                                    }}
                                                                >
                                                                    {hiddenTasks.map(hiddenTask => (
                                                                        <button key={taskKey(hiddenTask)} type="button" className="surface-focus block min-h-9 w-full rounded-lg px-2 text-left text-xs font-bold text-slate-200 hover:bg-slate-800" onClick={() => { setExpandedCollision(null); setEditingTask(hiddenTask); }}>
                                                                            {hiddenTask.title}
                                                                        </button>
                                                                    ))}
                                                                </motion.div>
                                                            )}
                                                        </AnimatePresence>
                                                    </>
                                                )}
                                            </div>
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
