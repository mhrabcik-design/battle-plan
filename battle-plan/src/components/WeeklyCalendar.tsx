import React from 'react';
import { Clock, Hourglass, Sun } from 'lucide-react';
import type { UnifiedTask } from '../types';
import {
    getWeekDays,
    getTimePosition,
    isOverCapacity,
    getDeadlineColor,
    formatTimeLeft,
    isAllDayTask
} from '../utils/calendarUtils';

interface WeeklyCalendarProps {
    weekOffset: number;
    tasks: UnifiedTask[];
    rowHeight: number;
    calendarHours: number[];
    currentTime: Date;
    currentHourPosition: number;
    setEditingTask: (task: UnifiedTask) => void;
}

const ALL_DAY_LANE_HEIGHT = 32; // px na každý all-day řádek
const ALL_DAY_VISIBLE_ROWS = 3; // max viditelných řádků bez scrollu

export const WeeklyCalendar: React.FC<WeeklyCalendarProps> = ({
    weekOffset,
    tasks,
    rowHeight,
    calendarHours,
    currentTime,
    currentHourPosition,
    setEditingTask
}) => {
    const days = getWeekDays(weekOffset);

    return (
        <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar relative">
                <div className="grid grid-cols-[60px_repeat(7,1fr)] min-w-[700px] md:min-w-[1200px] relative" style={{ height: `${calendarHours.length * rowHeight + 60}px` }}>

                    {/* TIME LABELS COLUMN */}
                    <div className="relative border-r border-white/10 bg-slate-950/40 z-20 ml-6 md:ml-10">
                        {calendarHours.map((hour) => (
                            <div key={hour} className="absolute left-0 w-full flex items-center justify-center -translate-y-1/2" style={{ top: `${(hour - 7) * rowHeight + 40}px`, height: `20px` }}>
                                <span className="text-xs font-black text-slate-400 tabular-nums">
                                    {hour < 10 ? `0${hour}:00` : `${hour}:00`}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* DAYS COLUMNS */}
                    {days.map((day) => {
                        const allDayTasks = tasks.filter(t => {
                            const matchesDay = t.type === 'task' ? t.deadline === day.full : t.date === day.full;
                            return matchesDay && isAllDayTask(t);
                        });
                        const timedTasks = tasks.filter(t => {
                            const matchesDay = t.type === 'task' ? t.deadline === day.full : t.date === day.full;
                            return matchesDay && !isAllDayTask(t);
                        });

                        const allDayLaneHeight = Math.max(ALL_DAY_LANE_HEIGHT, Math.min(allDayTasks.length, ALL_DAY_VISIBLE_ROWS) * ALL_DAY_LANE_HEIGHT);

                        return (
                            <div key={day.full} className={`relative border-r border-white/10 last:border-r-0 ${day.isToday ? 'bg-indigo-500/5' : day.isWeekend ? 'bg-amber-950/20' : ''}`}>

                                {/* DAY HEADER - STICKY */}
                                <div className={`sticky top-0 left-0 w-full h-10 border-b border-white/10 flex flex-col items-center justify-center backdrop-blur-md z-30 transition-colors ${day.isToday ? 'bg-indigo-600/25' : day.isWeekend ? 'bg-amber-900/40' : 'bg-slate-900/60'}`}>
                                    <span className={`text-xs uppercase font-black tracking-widest ${day.isToday ? 'text-indigo-300' : 'text-slate-400'}`}>{day.dayName}</span>
                                    <span className={`text-sm font-black leading-none ${day.isToday ? 'text-white' : 'text-slate-200'}`}>{day.dayNum}</span>
                                </div>

                                {/* ALL-DAY LANE */}
                                {allDayTasks.length > 0 && (
                                    <div
                                        className="absolute left-0 right-0 z-20 px-1 pt-1 space-y-1 overflow-y-auto no-scrollbar"
                                        style={{ top: '40px', height: `${allDayLaneHeight}px` }}
                                    >
                                        {allDayTasks.map(t => (
                                            <button
                                                key={t.isGoogleTask ? `g-${t.googleId}-allday` : `l-${t.id}-allday`}
                                                onClick={() => setEditingTask(t)}
                                                className={`w-full px-2 py-1 rounded-md border transition-all flex items-center gap-1.5 overflow-hidden ${t.status === 'completed' ? 'opacity-40' : 'hover:scale-[1.01] shadow-sm shadow-black/20'} ${t.type === 'meeting' ? 'bg-indigo-600/80 border-indigo-500/50 hover:border-indigo-300' : 'bg-amber-600/80 border-amber-500/50 hover:border-amber-300'}`}
                                            >
                                                <Sun className="w-3 h-3 text-white shrink-0" />
                                                <span className="text-sm font-bold uppercase tracking-tight text-white line-clamp-1 leading-tight">{t.title}</span>
                                                {t.isGoogleTask && <span className="text-sm bg-blue-500/30 text-blue-200 px-1 rounded-sm border border-blue-400/30 shrink-0">G</span>}
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* HOUR GRID LINES */}
                                {calendarHours.map((hour) => (
                                    <div
                                        key={hour}
                                        className="absolute left-0 w-full border-b border-white/5"
                                        style={{ top: `${(hour - 7) * rowHeight + 40}px`, height: `${rowHeight}px` }}
                                    />
                                ))}

                                {/* TIMED TASKS IN DAY */}
                                <div className="relative h-full z-10 mx-1">
                                    {timedTasks.map(t => {
                                        const height = Math.max(40, (t.duration || 60) / 60 * rowHeight);
                                        const basePos = getTimePosition(t.startTime, rowHeight);
                                        // Pivot: Task ends at startTime (deadline), Meeting starts at startTime
                                        const top = (t.type === 'task' ? (basePos - height) : basePos) + 40;

                                        return (
                                            <button
                                                key={t.isGoogleTask ? `g-${t.googleId}` : `l-${t.id}`}
                                                onClick={() => setEditingTask(t)}
                                                className={`absolute left-0 right-0 p-2 rounded-lg border transition-all flex flex-col gap-0.5 overflow-hidden group/item ${t.status === 'completed' ? 'opacity-40' : 'hover:z-30 hover:scale-[1.02] shadow-lg shadow-black/20'} ${t.type === 'meeting' ? 'bg-indigo-600 border-indigo-500/50 hover:border-indigo-400' : isOverCapacity(currentTime, t) ? 'bg-red-950/40 border-red-500/40 animate-pulse-red' : 'bg-slate-800/90 border-slate-700/60 hover:border-slate-500'}`}
                                                style={{ top: `${top}px`, height: `${height}px` }}
                                            >
                                                <div className={`absolute top-0 left-0 bottom-0 w-1 ${t.type === 'meeting' ? 'bg-indigo-300' : isOverCapacity(currentTime, t) ? 'bg-red-500' : 'bg-orange-500'} opacity-80`} />
                                                <div className="flex items-center justify-between gap-1">
                                                    <span className="text-xs font-black uppercase tracking-tight text-white line-clamp-1 leading-tight">{t.title}</span>
                                                    {t.isGoogleTask && <span className="text-sm bg-blue-500/20 text-blue-400 px-1 rounded-sm border border-blue-500/30 shrink-0">G</span>}
                                                </div>
                                                <div className="flex flex-col gap-1 mt-auto">
                                                    {t.startTime && (
                                                        <div className="flex items-center gap-1 opacity-60">
                                                            <Clock className="w-2.5 h-2.5 text-slate-400" />
                                                            <span className="text-sm font-bold text-slate-400">{t.startTime} {t.duration ? `(${t.duration}m)` : ''}</span>
                                                        </div>
                                                    )}
                                                    {t.type === 'task' && t.deadline && (
                                                        <div className="flex items-center gap-1 opacity-90">
                                                            <Hourglass className={`w-2.5 h-2.5 ${isOverCapacity(currentTime, t) ? 'text-red-400' : getDeadlineColor(currentTime, t.deadline, t.startTime)}`} />
                                                            <span className={`text-xs font-black uppercase tracking-tight ${isOverCapacity(currentTime, t) ? 'text-red-400' : getDeadlineColor(currentTime, t.deadline, t.startTime)}`}>
                                                                {formatTimeLeft(currentTime, t.deadline, t.startTime)}
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* CURRENT TIME INDICATOR */}
                                {day.isToday && currentHourPosition !== -1 && (
                                    <div
                                        className="absolute left-0 right-0 z-30 flex items-center pointer-events-none"
                                        style={{ top: `${currentHourPosition + 40}px` }}
                                    >
                                        <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] -ml-1" />
                                        <div className="flex-1 h-px bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.4)]" />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
