import type { UnifiedTask } from '../types';

export const formatTimeLeft = (currentTime: Date, targetDateStr?: string, targetTimeStr?: string) => {
    if (!targetDateStr) return "";
    const end = new Date(targetDateStr);
    if (isNaN(end.getTime())) return "";
    const [h, m] = (targetTimeStr || "15:00").split(':').map(Number);
    end.setHours(h, m, 0, 0);

    const diffMs = end.getTime() - currentTime.getTime();
    if (diffMs < 0) return "po termínu";

    const diffMins = Math.floor(diffMs / 60000);
    const days = Math.floor(diffMins / (24 * 60));
    const hours = Math.floor((diffMins % (24 * 60)) / 60);
    const mins = diffMins % 60;

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
};

export const getDeadlineColor = (currentTime: Date, targetDateStr?: string, targetTimeStr?: string) => {
    if (!targetDateStr) return "text-slate-500";
    const end = new Date(targetDateStr);
    if (isNaN(end.getTime())) return "text-slate-500";
    const [h, m] = (targetTimeStr || "15:00").split(':').map(Number);
    end.setHours(h, m, 0, 0);

    const diffMs = end.getTime() - currentTime.getTime();
    if (diffMs < 0) return "text-red-500";
    if (diffMs < 3 * 3600 * 1000) return "text-red-400";
    if (diffMs < 24 * 3600 * 1000) return "text-amber-400";
    return "text-emerald-400";
};

export const getAvailableWorkingMinutes = (currentTime: Date, targetDateStr?: string, targetTimeStr?: string) => {
    if (!targetDateStr) return 0;
    const end = new Date(targetDateStr);
    if (isNaN(end.getTime())) return 0;
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

        current = new Date(current);
        current.setDate(current.getDate() + 1);
        current.setHours(7, 0, 0, 0);
    }

    return totalMinutes;
};

export const isOverCapacity = (currentTime: Date, task: UnifiedTask) => {
    if (task.type !== 'task' || task.status === 'completed') return false;
    if (task.duration == null) return false;
    const available = getAvailableWorkingMinutes(currentTime, task.deadline, task.startTime);
    return task.duration > available;
};

export const getWeekDays = (offset: number) => {
    const today = new Date();
    const day = today.getDay();
    const diff = today.getDate() - day + (day === 0 ? -6 : 1) + (offset * 7);
    const start = new Date(today.getFullYear(), today.getMonth(), diff);

    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const full = `${y}-${m}-${dd}`;
        return {
            full,
            dayName: d.toLocaleDateString('cs-CZ', { weekday: 'short' }),
            dayNum: d.getDate(),
            isToday: full === todayStr,
            isWeekend: d.getDay() === 0 || d.getDay() === 6
        };
    });
};

export const getTimePosition = (timeStr: string | undefined, rowHeight: number) => {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return 0;
    const h = Math.max(7, Math.min(19, hours));
    const m = Math.max(0, Math.min(59, minutes));
    const totalMinutes = (h - 7) * 60 + m;
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

/**
 * Vrátí true, pokud úkol/schůzka zabírá celý den.
 * - isAllDay === true (nový field)
 * - nebo nemá startTime (legacy fallback)
 */
export const isAllDayTask = (task: { isAllDay?: boolean; startTime?: string }): boolean => {
    if (task.isAllDay === true) return true;
    if (task.isAllDay === false) return false;
    // Legacy fallback - pokud není isAllDay nastaveno, odvodíme z absence startTime
    return !task.startTime;
};

/**
 * Formátuje duration v minutách na lidsky čitelný text: "2h 30m", "45m", "1h".
 */
export const formatDuration = (minutes?: number): string => {
    if (minutes == null || minutes <= 0) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
};

/**
 * Parsuje lidský vstup ("2h 30m", "90m", "2:30", "2,5h") na minuty.
 * Vrací null pokud nelze parsovat.
 */
export const parseDuration = (input: string): number | null => {
    if (!input) return null;
    const s = input.trim().toLowerCase();

    // "2:30" = 2h 30m
    const colonMatch = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (colonMatch) {
        const h = parseInt(colonMatch[1], 10);
        const m = parseInt(colonMatch[2], 10);
        if (m >= 60) return null;
        return h * 60 + m;
    }

    // "2h 30m", "2h", "30m", "2,5h"
    let total = 0;
    let matched = false;
    const hMatch = s.match(/(\d+(?:[.,]\d+)?)\s*h/);
    if (hMatch) {
        const h = parseFloat(hMatch[1].replace(',', '.'));
        total += Math.round(h * 60);
        matched = true;
    }
    const mMatch = s.match(/(\d+)\s*m/);
    if (mMatch) {
        total += parseInt(mMatch[1], 10);
        matched = true;
    }
    if (matched) return total > 0 ? total : null;

    // "90" = 90 minut
    const plainMatch = s.match(/^\d+$/);
    if (plainMatch) {
        const n = parseInt(s, 10);
        return n > 0 ? n : null;
    }

    return null;
};
