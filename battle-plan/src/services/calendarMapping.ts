import type { Task } from '../db.ts';
import type { CalendarPublicProjection, CalendarTiming, GoogleCalendarEvent } from './calendarModel.ts';
import { sha256Hex } from './agentProtocol/validation.ts';

export function validCalendarDate(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
        && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

function civilDateAfter(date: string): string {
    return new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function zonedParts(timestamp: number, timeZone: string): { date: string; time: string; civil: number } {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp);
    const value = (key: string) => parts.find(part => part.type === key)!.value;
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const time = `${value('hour')}:${value('minute')}`;
    return { date, time, civil: Date.parse(`${date}T${time}:${value('second')}Z`) };
}

function zonedTimestamp(date: string, clock: string, timeZone: string): number | null {
    const civil = Date.parse(`${date}T${clock}:00Z`);
    let instant = civil;
    for (let attempt = 0; attempt < 3; attempt++) instant += civil - zonedParts(instant, timeZone).civil;
    const resolved = zonedParts(instant, timeZone);
    // A nonexistent DST wall time has no interval that matches the user's plan.
    return resolved.date === date && resolved.time === clock ? instant : null;
}

export type CalendarTaskSchedule = Pick<Task, 'date' | 'deadline' | 'startTime' | 'duration' | 'isAllDay'>;

export function calendarProjectionToTaskSchedule(projection: CalendarPublicProjection, type: 'task' | 'meeting'): CalendarTaskSchedule | null {
    const timing = projection.timing;
    if (timing.kind === 'all-day') {
        if (!validCalendarDate(timing.startDate) || !validCalendarDate(timing.endDate) || timing.endDate <= timing.startDate) return null;
        return { date: timing.startDate, deadline: timing.startDate, startTime: undefined, duration: undefined, isAllDay: true };
    }
    const start = Date.parse(timing.start), end = Date.parse(timing.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    try {
        const semantic = zonedParts(type === 'task' ? end : start, timing.timeZone);
        return { date: semantic.date, deadline: semantic.date, startTime: semantic.time, duration: (end - start) / 60_000, isAllDay: false };
    } catch { return null; }
}

function unchangedTiming(task: Task, timing: CalendarTiming): boolean {
    if (task.type !== 'task' && task.type !== 'meeting') return false;
    const schedule = calendarProjectionToTaskSchedule({ title: '', description: '', timing }, task.type);
    const date = task.type === 'task' ? task.deadline || task.date : task.date;
    return Boolean(schedule && (task.type === 'task' ? schedule.deadline : schedule.date) === date
        && Boolean(schedule.isAllDay) === Boolean(task.isAllDay)
        && (task.isAllDay || (schedule.startTime === task.startTime && schedule.duration === (task.duration || 60))));
}

/** Task.startTime means END; meeting.startTime means START. No viewport clipping/default dates. */
export function toCalendarProjection(task: Task, timeZone = task.calendar?.timing?.kind === 'timed' ? task.calendar.timing.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone): CalendarPublicProjection | null {
    if ((task.type !== 'task' && task.type !== 'meeting') || (task.type === 'task' && task.calendarScheduleExplicit === false)) return null;
    const exact = task.calendar?.timing;
    if (exact && unchangedTiming(task, exact)) return { title: task.title, description: task.description ?? '', timing: structuredClone(exact) };
    const date = task.type === 'task' ? task.deadline || task.date : task.date;
    if (!validCalendarDate(date)) return null;
    if (task.isAllDay || (task.type === 'task' && !task.startTime)) return { title: task.title, description: task.description ?? '', timing: { kind: 'all-day', startDate: date, endDate: civilDateAfter(date) } };
    if (!task.startTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.startTime)) return null;
    const duration = task.duration === undefined || task.duration === 0 ? 60 : task.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    try {
        const semantic = zonedTimestamp(date, task.startTime, timeZone);
        if (semantic === null) return null;
        const start = task.type === 'task' ? semantic - duration * 60_000 : semantic;
        const end = task.type === 'task' ? semantic : semantic + duration * 60_000;
        return { title: task.title, description: task.description ?? '', timing: { kind: 'timed', start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone } };
    } catch { return null; }
}

export function calendarEventProjection(event: GoogleCalendarEvent, defaultTimeZone: string): CalendarPublicProjection | null {
    let timing: CalendarTiming;
    if (event.start?.date && event.end?.date) {
        timing = { kind: 'all-day', startDate: event.start.date, endDate: event.end.date };
    } else if (event.start?.dateTime && event.end?.dateTime) {
        timing = { kind: 'timed', start: event.start.dateTime, end: event.end.dateTime, timeZone: event.start.timeZone ?? event.end.timeZone ?? defaultTimeZone };
    } else return null;
    const projection = { title: event.summary ?? '', description: event.description ?? '', timing };
    return calendarProjectionToTaskSchedule(projection, 'meeting') ? projection : null;
}

export function canonicalCalendarIdentity(task: Pick<Task, 'publicId' | 'suggestionOccurrenceKey' | 'calendar'>): string {
    if (task.calendar) return task.calendar.canonicalIdentity;
    if (task.suggestionOccurrenceKey) return `occurrence:${task.suggestionOccurrenceKey}`;
    if (!task.publicId) throw new Error('calendar_public_identity_required');
    return `public:${task.publicId}`;
}

function scopedHash(values: unknown[]): string { return sha256Hex(new TextEncoder().encode(JSON.stringify(values))); }

export function deterministicCalendarEventId(task: Pick<Task, 'publicId' | 'suggestionOccurrenceKey' | 'calendar'>, accountId: string, calendarId: string, generation: number): string {
    // Retain the existing bp + 128-bit ID shape, now derived from portable scope.
    return `bp${scopedHash(['battleplan-calendar-v1', accountId, calendarId, canonicalCalendarIdentity(task), generation]).slice(0, 32)}`;
}

export function calendarEventPublicId(accountId: string, calendarId: string, eventId: string): string {
    return `task_calendar_${scopedHash(['battleplan-calendar-import-v1', accountId, calendarId, eventId])}`;
}
