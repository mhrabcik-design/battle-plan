import assert from 'node:assert/strict';
import test from 'node:test';
import type { UnifiedTask } from '../types.ts';
import { projectCalendarDays, calendarTaskLabel, calendarIntervalLabel, calendarTaskOrigin, isOutsideWorkingHours } from './calendarPresentation.ts';
const days = ['2026-10-05', '2026-10-06', '2026-10-07'];
const event = (timing: NonNullable<UnifiedTask['calendar']>['timing']): UnifiedTask => ({
    id: 1, publicId: 'one-event', title: '', type: 'meeting', status: 'pending', urgency: 2, createdAt: 1, updatedAt: 1,
    calendar: { accountId: 'a', calendarId: 'primary', eventId: 'e', canonicalIdentity: 'e', origin: 'google', generation: 0,
        metadataUpdatedAt: 1, readonlyReason: 'multi-day', displayTimeZone: 'Europe/Prague', timing },
});
test('one stored event projects into two unique daily segments and leaves its public title untouched', () => {
    const task = event({ kind: 'timed', start: '2026-10-05T21:00:00+02:00', end: '2026-10-06T06:00:00+02:00', timeZone: 'Europe/Prague' });
    const result = projectCalendarDays([task], days);
    assert.deepEqual(result.map(t => [t.id, t.calendarSegment?.date, t.calendarSegment?.startMinute, t.calendarSegment?.endMinute]), [[1, days[0], 1260, 1440], [1, days[1], 0, 360]]);
    assert.notEqual(result[0].calendarSegment?.key, result[1].calendarSegment?.key);
    assert.equal(task.title, '');
    assert.equal(calendarTaskLabel(task), 'Událost bez názvu');
    assert.deepEqual(calendarTaskOrigin(result[0]), task);
});
test('all-day and timed midnight ends are exclusive, and overlap before week start is included', () => {
    assert.deepEqual(projectCalendarDays([event({ kind: 'all-day', startDate: '2026-10-04', endDate: '2026-10-07' })], days).map(t => t.calendarSegment?.date), days.slice(0, 2));
    assert.deepEqual(projectCalendarDays([event({ kind: 'timed', start: '2026-10-04T21:00:00+02:00', end: '2026-10-06T00:00:00+02:00', timeZone: 'Europe/Prague' })], days).map(t => t.calendarSegment?.date), [days[0]]);
});
test('display timezone determines days and civil clock, while original timing stays intact', () => {
    const task = event({ kind: 'timed', start: '2026-10-05T23:00:00-04:00', end: '2026-10-06T00:00:00-04:00', timeZone: 'America/New_York' });
    const [projected] = projectCalendarDays([task], days);
    assert.equal(projected.calendarSegment?.date, days[1]);
    assert.equal(projected.calendarSegment?.startMinute, 300);
    assert.equal(projected.calendarSegment?.endMinute, 360);
    assert.equal(projected.calendar?.timing, task.calendar?.timing);
});
test('early and late blocks stay visible outside working hours, and task clock is its end', () => {
    const local = (startTime: string, type: 'task' | 'meeting' = 'meeting'): UnifiedTask => ({ id: 2, title: 'Plán', type, date: days[0], deadline: days[0], startTime, duration: 60, status: 'pending', urgency: 2, createdAt: 1, updatedAt: 1 });
    assert.equal(isOutsideWorkingHours(local('06:00')), true);
    assert.equal(isOutsideWorkingHours(local('22:00')), true);
    assert.equal(isOutsideWorkingHours(local('07:00')), false);
    assert.equal(calendarIntervalLabel(local('15:00', 'task')), '14:00–15:00');
    assert.equal(calendarIntervalLabel(local('06:30')), '06:30–07:30');
});

test('an explicit local task ending after midnight shows both civil days with its real end', () => {
    const task: UnifiedTask = { id: 3, title: 'Noční práce', type: 'task', date: days[1], deadline: days[1], calendarScheduleExplicit: true, startTime: '00:30', duration: 60, status: 'pending', urgency: 2, createdAt: 1, updatedAt: 1 };
    const segments = projectCalendarDays([task], days);
    assert.deepEqual(segments.map(segment => [segment.calendarSegment?.date, calendarIntervalLabel(segment)]), [[days[0], '23:30–24:00'], [days[1], '00:00–00:30']]);
    assert.equal(segments.every(isOutsideWorkingHours), true);
});
