/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarAcknowledgedTask, calendarChangedFields, rebaseCalendarProjection, reconcileCalendarProjection, safeGoogleCalendarLink } from './calendarReconciliation.ts';
import type { Task } from '../db.ts';
import type { CalendarPublicProjection } from './calendarModel.ts';

const base: CalendarPublicProjection = { title: 'A', description: 'Original', timing: {
    kind: 'timed', start: '2026-10-09T12:00:00Z', end: '2026-10-09T13:00:00Z', timeZone: 'Europe/Prague' } };

test('reconciliation merges disjoint shared fields and reports both sides of same-field conflicts', () => {
    const local = { ...base, title: 'B' }, remote = { ...base, description: 'Google' };
    assert.deepEqual(reconcileCalendarProjection(base, local, remote).projection, { ...remote, title: 'B' });
    const result = reconcileCalendarProjection(base, local, { ...remote, title: 'C' }, '"v2"', 123);
    assert.deepEqual(result.conflict, { kind: 'fields', fields: ['title'], base, local,
        remote: { ...remote, title: 'C' }, remoteEtag: '"v2"', detectedAt: 123 });
});

test('timing compares instants across normalized offsets and keeps timezone/all-day semantics', () => {
    const normalized = { ...base, timing: { kind: 'timed' as const, start: '2026-10-09T14:00:00+02:00', end: '2026-10-09T15:00:00+02:00', timeZone: 'Europe/Prague' } };
    assert.deepEqual(calendarChangedFields(base, normalized), []);
    assert.deepEqual(calendarChangedFields(base, { ...normalized, timing: { ...normalized.timing, timeZone: 'UTC' } }), ['timing']);
    const allDay: CalendarPublicProjection = { ...base, timing: { kind: 'all-day', startDate: '2026-10-09', endDate: '2026-10-10' } };
    assert.deepEqual(calendarChangedFields(allDay, { ...allDay, timing: { kind: 'all-day', startDate: '2026-10-09', endDate: '2026-10-11' } }), ['timing']);
});

test('timing endpoints form one conflict field instead of an invalid combined interval', () => {
    if (base.timing.kind !== 'timed') throw new Error('timed');
    const local = { ...base, timing: { ...base.timing, start: '2026-10-09T11:00:00Z' } };
    const remote = { ...base, timing: { ...base.timing, end: '2026-10-09T14:00:00Z' } };
    assert.deepEqual(reconcileCalendarProjection(base, local, remote).conflict?.fields, ['timing']);
});

test('queued pre-ack edits rebase only fields authored by that mutation', () => {
    assert.deepEqual(rebaseCalendarProjection({ ...base, title: 'B' }, base, { ...base, description: 'Google' }),
        { ...base, title: 'B', description: 'Google' });
    assert.deepEqual(rebaseCalendarProjection(base, undefined, { ...base, description: 'Google' }), base);
});

test('a missing legacy baseline never decides a differing remote field automatically', () => {
    assert.equal(reconcileCalendarProjection(undefined, base, { ...base, title: 'Google' }).conflict?.kind, 'legacy-baseline');
    assert.deepEqual(reconcileCalendarProjection(undefined, base, base).projection, base);
});

test('readonly Google links use a strict HTTPS Calendar allowlist without requiring organizer ownership', () => {
    assert.equal(safeGoogleCalendarLink('https://calendar.google.com/calendar/event?eid=foreign'), 'https://calendar.google.com/calendar/event?eid=foreign');
    for (const input of [undefined, 'javascript:alert(1)', 'https://calendar.google.com.evil.test/calendar/event',
        'https://user@calendar.google.com/calendar/event', 'https://calendar.google.com/calendar-evil', 'https://calendar.google.com:444/calendar/event']) {
        assert.equal(safeGoogleCalendarLink(input), undefined);
    }
});

test('Google changes a work block to all-day without erasing the local remaining duration', () => {
    const scope = { accountId: 'owner', calendarId: 'primary', eventId: 'event', canonicalIdentity: 'public:p', generation: 0 };
    const task: Task = { title: 'A', description: 'Original', type: 'task', status: 'pending', urgency: 2,
        date: '2026-10-09', deadline: '2026-10-09', startTime: '15:00', duration: 60, createdAt: 1, updatedAt: 1,
        calendar: { ...scope, origin: 'local', metadataUpdatedAt: 1, timing: base.timing } };
    const allDay: CalendarPublicProjection = { ...base, timing: { kind: 'all-day', startDate: '2026-10-09', endDate: '2026-10-10' } };
    const result = calendarAcknowledgedTask(task, { ...scope, sentProjection: base, projection: allDay, etag: '"new"' }, 2);
    assert.equal(result.task.isAllDay, true);
    assert.equal(result.task.duration, 60);
    assert.equal(result.task.startTime, undefined);
});

test('fresh deletion acknowledgements preserve concurrent local edits and expose deletion conflicts', () => {
    const scope = { accountId: 'owner', calendarId: 'primary', eventId: 'event', canonicalIdentity: 'public:p', generation: 0 };
    const task: Task = { title: 'B', description: 'Original', type: 'meeting', status: 'pending', urgency: 2,
        date: '2026-10-09', startTime: '14:00', duration: 60, createdAt: 1, updatedAt: 1,
        calendar: { ...scope, origin: 'local', metadataUpdatedAt: 1, timing: base.timing } };
    const deleted = calendarAcknowledgedTask(task, { ...scope, sentProjection: base, deleted: true }, 2).task;
    assert.equal(deleted.title, 'B'); assert.equal(deleted.isDeleted, undefined);
    assert.equal(deleted.calendar?.conflict?.kind, 'remote-deleted'); assert.equal(deleted.calendar?.suppressed, true);
    const archived = { ...task, title: 'A', isDeleted: true };
    const editedRemote = calendarAcknowledgedTask(archived, { ...scope, sentProjection: base,
        projection: { ...base, title: 'Google' }, etag: '"v2"' }, 2).task;
    assert.equal(editedRemote.isDeleted, true); assert.equal(editedRemote.title, 'A');
    assert.equal(editedRemote.calendar?.conflict?.kind, 'local-deleted');
});
