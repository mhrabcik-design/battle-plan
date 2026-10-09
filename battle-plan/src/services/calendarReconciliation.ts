import type { Task } from '../db.ts';
import { calendarProjectionToTaskSchedule, toCalendarProjection } from './calendarMapping.ts';
import type { CalendarConflict, CalendarPublicProjection, GoogleCalendarEvent } from './calendarModel.ts';

export const CALENDAR_SHARED_FIELDS = ['title', 'description', 'timing'] as const;
export type CalendarSharedField = typeof CALENDAR_SHARED_FIELDS[number];

export interface CalendarEffectScope {
    accountId: string;
    calendarId: string;
    eventId: string;
    canonicalIdentity: string;
    generation: number;
}
export interface CalendarWriteRequest extends CalendarEffectScope {
    operation: 'upsert' | 'delete';
    type: 'task' | 'meeting';
    origin?: 'local' | 'google';
    knownEvent?: boolean;
    projection?: CalendarPublicProjection;
    previousProjection?: CalendarPublicProjection;
    baseline?: CalendarPublicProjection;
    /** Original queued intent, before rebasing remote-only fields. */
    sentProjection?: CalendarPublicProjection;
    currentProjection?: CalendarPublicProjection;
    /** Durable local mutation ID proves a lost-response retry of this create. */
    createMutationId?: string;
}
export interface CalendarWriteAcknowledgement extends CalendarEffectScope {
    projection?: CalendarPublicProjection;
    sentProjection?: CalendarPublicProjection;
    etag?: string;
    deleted?: boolean;
    event?: GoogleCalendarEvent;
}
export interface CalendarWriteResult { externalId: string; calendar: CalendarWriteAcknowledgement }

export function calendarFieldEqual(field: CalendarSharedField, a: CalendarPublicProjection, b: CalendarPublicProjection): boolean {
    if (field !== 'timing') return a[field] === b[field];
    const left = a.timing, right = b.timing;
    if (left.kind !== right.kind) return false;
    if (left.kind === 'all-day' && right.kind === 'all-day') return left.startDate === right.startDate && left.endDate === right.endDate;
    return left.kind === 'timed' && right.kind === 'timed' && Date.parse(left.start) === Date.parse(right.start)
        && Date.parse(left.end) === Date.parse(right.end) && left.timeZone === right.timeZone;
}
export const calendarChangedFields = (a: CalendarPublicProjection, b: CalendarPublicProjection): CalendarSharedField[] =>
    CALENDAR_SHARED_FIELDS.filter(field => !calendarFieldEqual(field, a, b));

/** Only this queued mutation's authored fields survive a newer common baseline. */
export function rebaseCalendarProjection(projection: CalendarPublicProjection, previous: CalendarPublicProjection | undefined,
    baseline: CalendarPublicProjection | undefined): CalendarPublicProjection {
    if (!previous || !baseline) return structuredClone(projection);
    const result = structuredClone(baseline);
    for (const field of calendarChangedFields(previous, projection)) Object.assign(result, { [field]: structuredClone(projection[field]) });
    return result;
}

/** Timing is atomic; timestamps never decide who wins a common field. */
export function reconcileCalendarProjection(base: CalendarPublicProjection | undefined, local: CalendarPublicProjection,
    remote: CalendarPublicProjection, remoteEtag?: string, detectedAt = Date.now()):
    { projection: CalendarPublicProjection; conflict?: undefined } | { projection?: undefined; conflict: CalendarConflict } {
    if (!base) {
        const fields = calendarChangedFields(local, remote);
        if (fields.length) return { conflict: { kind: 'legacy-baseline', fields, local, remote, remoteEtag, detectedAt } };
        return { projection: structuredClone(remote) };
    }
    const merged = structuredClone(remote);
    const conflicts: CalendarSharedField[] = [];
    for (const field of CALENDAR_SHARED_FIELDS) {
        const localChanged = !calendarFieldEqual(field, local, base), remoteChanged = !calendarFieldEqual(field, remote, base);
        if (localChanged && remoteChanged && !calendarFieldEqual(field, local, remote)) conflicts.push(field);
        else if (localChanged) Object.assign(merged, { [field]: structuredClone(local[field]) });
    }
    if (conflicts.length) return { conflict: { kind: 'fields', fields: conflicts, base, local, remote, remoteEtag, detectedAt } };
    return { projection: merged };
}

export function calendarScopeMatches(task: Task | undefined, scope: CalendarEffectScope): boolean {
    const meta = task?.calendar;
    return Boolean(meta && meta.accountId === scope.accountId && meta.calendarId === scope.calendarId
        && meta.eventId === scope.eventId && meta.canonicalIdentity === scope.canonicalIdentity && meta.generation === scope.generation);
}

/** A late ack may accept Google-only fields, never a newer authored value. */
export function calendarAcknowledgedTask(task: Task, ack: CalendarWriteAcknowledgement, now: number): { task: Task; contentChanged: boolean } {
    if (!calendarScopeMatches(task, ack) || task.calendar!.conflict) return { task, contentChanged: false };
    const local = toCalendarProjection(task);
    let conflict: CalendarConflict | undefined;
    if (local && ack.sentProjection) {
        if (ack.deleted && calendarChangedFields(ack.sentProjection, local).length && !task.isDeleted) {
            conflict = { kind: 'remote-deleted', fields: [], base: ack.sentProjection, local, detectedAt: now };
        } else if (ack.projection) {
            if (task.isDeleted && calendarChangedFields(ack.sentProjection, ack.projection).length) {
                conflict = { kind: 'local-deleted', fields: calendarChangedFields(ack.sentProjection, ack.projection),
                    base: ack.sentProjection, local, remote: ack.projection, remoteEtag: ack.etag, detectedAt: now };
            } else conflict = reconcileCalendarProjection(ack.sentProjection, local, ack.projection, ack.etag, now).conflict;
        }
    }
    const metadata = { ...task.calendar!, baseline: ack.projection ?? task.calendar!.baseline,
        etag: ack.etag ?? task.calendar!.etag, timing: ack.projection?.timing ?? task.calendar!.timing,
        metadataUpdatedAt: Math.max(now, task.calendar!.metadataUpdatedAt + 1),
        ...(ack.deleted ? { suppressed: true } : {}),
        ...(conflict ? { conflict } : {}),
    };
    let next: Task = { ...task, calendar: metadata, googleEventId: ack.eventId };
    let contentChanged = false;
    if (!task.isDeleted && (task.type === 'task' || task.type === 'meeting') && local && ack.projection && ack.sentProjection) {
        for (const field of CALENDAR_SHARED_FIELDS) {
            if (!calendarFieldEqual(field, local, ack.sentProjection) || calendarFieldEqual(field, local, ack.projection)) continue;
            if (field === 'timing') {
                const schedule = calendarProjectionToTaskSchedule(ack.projection, task.type);
                if (!schedule) continue;
                if (task.type === 'task' && ack.projection.timing.kind === 'all-day') schedule.duration = task.duration;
                next = { ...next, ...schedule };
            } else next = { ...next, [field]: ack.projection[field] };
            contentChanged = true;
        }
    }
    if (ack.deleted && !conflict && task.type === 'meeting' && !task.isDeleted) { next.isDeleted = true; contentChanged = true; }
    return { task: next, contentChanged };
}

export function safeGoogleCalendarLink(value: unknown): string | undefined {
    if (typeof value !== 'string') return;
    try {
        const link = new URL(value);
        if (link.protocol === 'https:' && !link.username && !link.password && !link.port
            && ['calendar.google.com', 'www.google.com'].includes(link.hostname) && link.pathname.startsWith('/calendar/')) return link.href;
    } catch { /* Untrusted htmlLink is omitted. */ }
}

/** These private names are the portable pairing contract consumed by inbound sync. */
export function calendarPrivateIdentity(input: Pick<CalendarWriteRequest, keyof CalendarEffectScope | 'type' | 'origin'>): Record<string, string> {
    return { battleplanIdentity: input.canonicalIdentity, battleplanAccount: input.accountId, battleplanCalendar: input.calendarId,
        battleplanType: input.type, battleplanOrigin: input.origin ?? 'local', battleplanGeneration: String(input.generation) };
}
