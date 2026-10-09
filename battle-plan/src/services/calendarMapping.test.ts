import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '../db.ts';
import { toCalendarProjection, calendarProjectionToTaskSchedule, canonicalCalendarIdentity, deterministicCalendarEventId, calendarEventPublicId } from './calendarMapping.ts';

const task = (changes: Partial<Task> = {}): Task => ({ publicId: 'task_a', title: 'Work [BP]', description: 'Public', internalNotes: 'Private', type: 'task', urgency: 2, status: 'pending', createdAt: 1, updatedAt: 1,
    date: '2026-10-01', deadline: '2026-10-09', startTime: '15:00', duration: 60, ...changes });

test('task clock is the end and meeting clock is the start; private content is excluded', () => {
    assert.deepEqual(toCalendarProjection(task(), 'Europe/Prague'), { title: 'Work [BP]', description: 'Public', timing: { kind: 'timed', start: '2026-10-09T12:00:00.000Z', end: '2026-10-09T13:00:00.000Z', timeZone: 'Europe/Prague' } });
    assert.deepEqual(toCalendarProjection(task({ type: 'meeting', date: '2026-10-09' }), 'Europe/Prague')?.timing,
        { kind: 'timed', start: '2026-10-09T13:00:00.000Z', end: '2026-10-09T14:00:00.000Z', timeZone: 'Europe/Prague' });
});

test('all-day uses civil exclusive end across DST, and timing may cross midnight outside viewport', () => {
    assert.deepEqual(toCalendarProjection(task({ deadline: '2026-03-29', isAllDay: true, startTime: undefined }), 'Europe/Prague')?.timing,
        { kind: 'all-day', startDate: '2026-03-29', endDate: '2026-03-30' });
    assert.deepEqual(toCalendarProjection(task({ deadline: '2026-10-09', startTime: '00:30' }), 'UTC')?.timing,
        { kind: 'timed', start: '2026-10-08T23:30:00.000Z', end: '2026-10-09T00:30:00.000Z', timeZone: 'UTC' });
});

test('mapper does not invent dates, times or invalid duration', () => {
    for (const changes of [{ date: undefined, deadline: undefined }, { duration: NaN }, { duration: -5 }, { deadline: '2026-02-30' }, { calendarScheduleExplicit: false }]) {
        assert.equal(toCalendarProjection(task(changes), 'UTC'), null);
    }
});

test('explicit date-only task exports a civil all-day block; incomplete timed meeting stays unplanned', () => {
    assert.deepEqual(toCalendarProjection(task({ startTime: undefined }), 'Europe/Prague')?.timing,
        { kind: 'all-day', startDate: '2026-10-09', endDate: '2026-10-10' });
    assert.equal(toCalendarProjection(task({ type: 'meeting', startTime: undefined }), 'Europe/Prague'), null);
});

test('remote move maps task end, keeps exact interval when schedule unchanged and respects timezone', () => {
    const projection = { title: 'Moved', description: 'Public', timing: { kind: 'timed' as const, start: '2026-10-09T16:00:30+02:00', end: '2026-10-09T17:00:30+02:00', timeZone: 'Europe/Prague' } };
    const schedule = calendarProjectionToTaskSchedule(projection, 'task');
    assert.deepEqual(schedule, { date: '2026-10-09', deadline: '2026-10-09', startTime: '17:00', duration: 60, isAllDay: false });
    const linked = task({ ...schedule, calendar: { accountId: 'a', calendarId: 'primary', eventId: 'e', canonicalIdentity: 'public:task_a', origin: 'local', generation: 0, metadataUpdatedAt: 1, timing: projection.timing } });
    assert.deepEqual(toCalendarProjection(linked, 'UTC')?.timing, projection.timing);
    assert.notDeepEqual(toCalendarProjection({ ...linked, startTime: '18:00' }, 'Europe/Prague')?.timing, projection.timing);
});

test('stable target scopes portable occurrence, account, calendar and generation; import identity scopes event', () => {
    const first = task({ suggestionOccurrenceKey: 'one' });
    const second = task({ publicId: 'task_b', suggestionOccurrenceKey: 'one' });
    assert.equal(canonicalCalendarIdentity(first), 'occurrence:one');
    const target = deterministicCalendarEventId(first, 'a', 'primary', 0);
    assert.match(target, /^bp[a-f0-9]{32}$/);
    assert.equal(deterministicCalendarEventId(second, 'a', 'primary', 0), target);
    for (const [account, calendar, generation] of [['b', 'primary', 0], ['a', 'other', 0], ['a', 'primary', 1]] as const) {
        assert.notEqual(deterministicCalendarEventId(first, account, calendar, generation), target);
    }
    assert.equal(calendarEventPublicId('a', 'primary', 'event'), calendarEventPublicId('a', 'primary', 'event'));
    assert.notEqual(calendarEventPublicId('b', 'primary', 'event'), calendarEventPublicId('a', 'primary', 'event'));
});
