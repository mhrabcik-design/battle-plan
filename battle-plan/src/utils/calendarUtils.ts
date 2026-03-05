import type { UnifiedTask } from '../types';

export const formatTimeLeft = (currentTime: Date, targetDateStr?: string, targetTimeStr?: string) => {
    if (!targetDateStr) return "";
    const end = new Date(targetDateStr);
    const [h, m] = (targetTimeStr || "15:00").split(':').map(Number);
    end.setHours(h, m, 0, 0);

    const diffMs = end.getTime() - currentTime.getTime();
    if (diffMs < 0) return "po termínu";

    const diffMins = Math.floor(diffMs / 60000);
    const days = Math.floor(diffMins / (24 * 60));
    const hours = Math.floor((diffMins % (24 * 60)) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h ${diffMins % 60}m`;
};

export const getDeadlineColor = (currentTime: Date, targetDateStr?: string, targetTimeStr?: string) => {
    if (!targetDateStr) return "text-slate-500";
    const end = new Date(targetDateStr);
    const [h, m] = (targetTimeStr || "15:00").split(':').map(Number);
    end.setHours(h, m, 0, 0);

    const diffMs = end.getTime() - currentTime.getTime();
    if (diffMs < 0) return "text-red-500"; // Past deadline
    if (diffMs < 3 * 3600 * 1000) return "text-red-400"; // Very close (< 3h)
    if (diffMs < 24 * 3600 * 1000) return "text-amber-400"; // Today (< 24h)
    return "text-emerald-400"; // Plenty of time
};

export const getAvailableWorkingMinutes = (currentTime: Date, targetDateStr?: string, targetTimeStr?: string) => {
    if (!targetDateStr) return 0;
    const end = new Date(targetDateStr);
    const [h, m] = (targetTimeStr || "15:00").split(':').map(Number);
    end.setHours(h, m, 0, 0);

    let totalMinutes = 0;
    let current = new Date(currentTime);

    if (current >= end) return 0;

    while (current < end) {
        const todayEnd = new Date(current);
        todayEnd.setHours(19, 0, 0, 0);

        const todayStart = new Date(current);
        todayStart.setHours(7, 0, 0, 0);

        let currentStart = new Date(current);
        if (currentStart < todayStart) currentStart = todayStart;

        let currentEnd = todayEnd;
        if (end < currentEnd) currentEnd = end;

        if (currentStart < currentEnd) {
            totalMinutes += Math.floor((currentEnd.getTime() - currentStart.getTime()) / 60000);
        }

        current.setDate(current.getDate() + 1);
        current.setHours(7, 0, 0, 0);
    }

    return totalMinutes;
};

export const isOverCapacity = (currentTime: Date, task: UnifiedTask) => {
    if (task.type !== 'task' || task.status === 'completed') return false;
    const duration = task.duration || 0;
    const available = getAvailableWorkingMinutes(currentTime, task.deadline, task.startTime);
    return duration > available;
};

export const getWeekDays = (offset: number) => {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1) + (offset * 7);
    const start = new Date(today.setDate(diff));

    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return {
            full: d.toISOString().split('T')[0],
            dayName: d.toLocaleDateString('cs-CZ', { weekday: 'short' }),
            dayNum: d.getDate(),
            isToday: d.toISOString().split('T')[0] === new Date().toISOString().split('T')[0],
            isWeekend: d.getDay() === 0 || d.getDay() === 6
        };
    });
};

export const getTimePosition = (timeStr: string | undefined, rowHeight: number) => {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    const h = Math.max(7, Math.min(19, hours));
    const totalMinutes = (h - 7) * 60 + minutes;
    return (totalMinutes / 60) * rowHeight;
};

export const getUrgencyColor = (urgency?: number) => {
    switch (urgency) {
        case 3: return 'text-red-400 border-red-400/30 bg-red-400/10';
        case 2: return 'text-blue-400 border-blue-400/30 bg-blue-400/10';
        case 1: return 'text-slate-400 border-slate-400/30 bg-slate-400/10';
        default: return 'text-blue-400 border-blue-400/30 bg-blue-400/10';
    }
};
