import type { Task } from '../db.ts';
import type { TaskCalendarMetadata } from './calendarModel.ts';
import { canonicalBackupJson } from '../utils/canonicalBackupJson.ts';

/** Reject ambiguous pairing instead of arbitrarily adopting another remote target. */
export function mergeCalendarMetadata(values: readonly (TaskCalendarMetadata | undefined)[]): TaskCalendarMetadata | undefined {
    const present = values.filter((value): value is TaskCalendarMetadata => value !== undefined);
    if (!present.length) return undefined;
    for (const value of present) {
        if (!value || typeof value !== 'object' || ![value.accountId, value.calendarId, value.eventId, value.canonicalIdentity].every(field => typeof field === 'string' && field.length > 0)
            || !['local', 'google'].includes(value.origin) || !Number.isSafeInteger(value.generation) || value.generation < 0
            || !Number.isFinite(value.metadataUpdatedAt) || value.metadataUpdatedAt < 0
            || (value.suppressed !== undefined && typeof value.suppressed !== 'boolean')) throw new Error('Neplatná Calendar metadata v záloze.');
    }
    const identity = (value: TaskCalendarMetadata) => canonicalBackupJson([value.accountId, value.calendarId, value.canonicalIdentity, value.origin]);
    if (new Set(present.map(identity)).size > 1) throw new Error('Konflikt Calendar identity v zálohách.');
    const generation = Math.max(...present.map(value => value.generation));
    const current = present.filter(value => value.generation === generation);
    if (new Set(current.map(value => value.eventId)).size > 1) throw new Error('Konflikt Calendar pairing v zálohách.');
    const newest = Math.max(...current.map(value => value.metadataUpdatedAt));
    const winners = current.filter(value => value.metadataUpdatedAt === newest);
    if (new Set(winners.map(canonicalBackupJson)).size > 1) throw new Error('Konflikt stejně nových Calendar metadat.');
    const winner = structuredClone(winners[0]);
    // Cancellation is monotonic inside one generation. Only explicit restore
    // allocates a new generation and can remove suppression.
    if (current.some(value => value.suppressed)) winner.suppressed = true;
    return winner;
}

/** Carry the winning generation into legacy delivery aliases without reviving an old ID. */
export function applyCalendarPairing(task: Task, metadata: TaskCalendarMetadata, acknowledgedEventId?: string): Task {
    const copy = { ...task, calendar: metadata, googleAccountId: metadata.accountId, reservedGoogleEventId: metadata.eventId };
    if (copy.googleEventId && copy.googleEventId !== metadata.eventId) delete copy.googleEventId;
    if (acknowledgedEventId === metadata.eventId) copy.googleEventId = metadata.eventId;
    return copy;
}

/** Same projection for publication and its observer revision, never credentials/config. */
export function projectTasksForCalendarAccount(tasks: readonly Task[], accountId: string | null | undefined): Task[] {
    return tasks.filter(task => task.calendar?.origin !== 'google' || task.calendar.accountId === accountId).map(task => {
        const copy = structuredClone(task);
        if (copy.calendar && copy.calendar.accountId !== accountId) {
            delete copy.calendar;
            delete copy.googleEventId;
            delete copy.reservedGoogleEventId;
            if (copy.googleAccountId === task.calendar?.accountId) delete copy.googleAccountId;
        }
        return copy;
    });
}
