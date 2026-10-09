import type { UnifiedTask } from '../types.ts';
import type { CalendarPublicProjection, CalendarTiming } from '../services/calendarModel.ts';
import { toCalendarProjection } from '../services/calendarMapping.ts';
import { safeGoogleCalendarLink } from '../services/calendarReconciliation.ts';
import { getWeeklyVisualBlock, isAllDayTask, WEEKLY_CALENDAR_END_MINUTES, WEEKLY_CALENDAR_START_MINUTES } from './calendarUtils.ts';

export const CALENDAR_READONLY_NOTICE = 'Tato událost Google Kalendáře je pouze pro čtení. Upravte ji v Google Kalendáři.';
export const calendarTaskLabel = (task: Pick<UnifiedTask, 'title' | 'calendar'>): string => task.title || (task.calendar ? 'Událost bez názvu' : 'Bez názvu');
export const isCalendarReadonly = (task: UnifiedTask): boolean => !task.isGoogleTask && !!task.calendar?.readonlyReason;
export function openReadonlyCalendarTask(task: UnifiedTask): boolean {
    if (!isCalendarReadonly(task)) return false;
    const link = safeGoogleCalendarLink(task.calendar?.htmlLink);
    if (link) window.open(link, '_blank', 'noopener,noreferrer');
    else alert('Odkaz na událost není dostupný. Otevřete ji přímo v Google Kalendáři.');
    return true;
}
export const calendarTaskKey = (task: UnifiedTask): string => task.calendarSegment?.key ?? (task.isGoogleTask ? `g-${task.googleId}` : `l-${task.id}`);
export const isCalendarAllDay = (task: UnifiedTask): boolean => task.calendarSegment?.isAllDay ?? isAllDayTask(task);
export function calendarTaskOrigin(task: UnifiedTask): UnifiedTask {
    const origin = { ...task };
    delete origin.calendarSegment;
    return origin;
}

function civilEndpoint(value: string, timeZone: string): { date: string; minute: number } | null {
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
        const part = (name: string) => parts.find(item => item.type === name)?.value ?? '';
        return { date: `${part('year')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')) + Number(part('second')) / 60 };
    } catch { return null; }
}
const displayZone = (task: UnifiedTask): string => task.calendar?.displayTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const taskTiming = (task: UnifiedTask): CalendarTiming | undefined => task.isGoogleTask ? undefined
    : isCalendarReadonly(task) ? task.calendar?.timing : toCalendarProjection(task, displayZone(task))?.timing;

/** Project only requested civil days. Identity, public fields and stored interval remain atomic. */
export function projectCalendarDays(tasks: readonly UnifiedTask[], dates: readonly string[]): UnifiedTask[] {
    return tasks.flatMap(task => {
        if (task.isDeleted || task.calendar?.recurringMaster) return [];
        const timing = taskTiming(task);
        if (!timing) {
            const date = task.type === 'task' ? task.deadline : task.date;
            return date && dates.includes(date) ? [task] : [];
        }
        const zone = displayZone(task);
        const start = timing.kind === 'timed' ? civilEndpoint(timing.start, zone) : { date: timing.startDate, minute: 0 };
        const end = timing.kind === 'timed' ? civilEndpoint(timing.end, zone) : { date: timing.endDate, minute: 0 };
        if (!start || !end) return [];
        return dates.filter(date => date >= start.date && (date < end.date || date === end.date && end.minute > 0)).map(date => ({
            ...task, calendarSegment: { key: `${task.isGoogleTask ? `g-${task.googleId}` : task.publicId ?? `l-${task.id}`}:${date}`,
                date, isAllDay: timing.kind === 'all-day', startMinute: date === start.date ? start.minute : 0,
                endMinute: date === end.date ? end.minute : 1440 },
        }));
    });
}
export function calendarTaskOverlapsWeek(task: UnifiedTask, start: string, end: string): boolean {
    const timing = taskTiming(task);
    if (!timing || task.calendar?.recurringMaster) return false;
    if (timing.kind === 'all-day') return timing.startDate <= end && timing.endDate > start;
    const from = civilEndpoint(timing.start, displayZone(task));
    const to = civilEndpoint(timing.end, displayZone(task));
    return !!from && !!to && from.date <= end && (to.date > start || to.date === start && to.minute > 0);
}
export function calendarVisualBlock(task: UnifiedTask): { startMinute: number; endMinute: number } {
    return task.calendarSegment ?? getWeeklyVisualBlock(task);
}
const clock = (minute: number): string => {
    const civilMinute = minute === 1440 ? 1440 : (minute % 1440 + 1440) % 1440;
    return `${String(Math.floor(civilMinute / 60)).padStart(2, '0')}:${String(Math.floor(civilMinute % 60)).padStart(2, '0')}`;
};
export function calendarIntervalLabel(task: UnifiedTask): string {
    if (task.calendarSegment?.isAllDay || !task.calendarSegment && (task.isAllDay || !task.startTime)) return 'Celý den';
    const { startMinute, endMinute } = calendarVisualBlock(task);
    return `${clock(startMinute)}–${clock(endMinute)}`;
}
export function isOutsideWorkingHours(task: UnifiedTask): boolean {
    const block = calendarVisualBlock(task);
    return block.endMinute <= WEEKLY_CALENDAR_START_MINUTES || block.startMinute >= WEEKLY_CALENDAR_END_MINUTES;
}
export function calendarProjectionLabel(projection: CalendarPublicProjection, timeZone: string): string {
    const timing = projection.timing;
    if (timing.kind === 'all-day') {
        const last = new Date(`${timing.endDate}T12:00:00Z`);
        last.setUTCDate(last.getUTCDate() - 1);
        const end = last.toISOString().slice(0, 10);
        return `${timing.startDate}${end === timing.startDate ? '' : ` – ${end}`} · celý den`;
    }
    const start = civilEndpoint(timing.start, timeZone), end = civilEndpoint(timing.end, timeZone);
    return start && end ? `${start.date} ${clock(start.minute)} – ${end.date === start.date ? '' : `${end.date} `}${clock(end.minute)} (${timeZone})` : 'Nepodporovaný čas události';
}
