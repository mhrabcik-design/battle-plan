import test from 'node:test';
import assert from 'node:assert/strict';
import { isTaskVisibleInWeek } from './taskHistory.ts';
import type { Task } from '../db.ts';

const row = (overrides: Partial<Task>): Task => ({
    title: 'Historický úkol',
    type: 'task',
    status: 'pending',
    urgency: 2,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
});

test('completed task remains visible in its scheduled historical week', () => {
    assert.equal(isTaskVisibleInWeek(row({ status: 'completed', deadline: '2026-05-05' }), '2026-05-04', '2026-05-10'), true);
});

test('weekly inclusion respects canonical date field and excludes deleted or unsupported rows', () => {
    assert.equal(isTaskVisibleInWeek(row({ type: 'meeting', date: '2026-05-06' }), '2026-05-04', '2026-05-10'), true);
    assert.equal(isTaskVisibleInWeek(row({ type: 'task', date: '2026-05-06', deadline: '2026-05-12' }), '2026-05-04', '2026-05-10'), false);
    assert.equal(isTaskVisibleInWeek(row({ type: 'thought', date: '2026-05-06' }), '2026-05-04', '2026-05-10'), false);
    assert.equal(isTaskVisibleInWeek(row({ deadline: '2026-05-06', isDeleted: true }), '2026-05-04', '2026-05-10'), false);
});

test('Calendar interval beginning before the week overlaps it, with exclusive end', () => {
    const calendar = { accountId: 'a', calendarId: 'primary', eventId: 'e', canonicalIdentity: 'e', origin: 'google' as const,
        generation: 0, metadataUpdatedAt: 1, readonlyReason: 'multi-day' as const,
        timing: { kind: 'all-day' as const, startDate: '2026-05-02', endDate: '2026-05-06' } };
    assert.equal(isTaskVisibleInWeek(row({ type: 'meeting', date: '2026-05-02', calendar }), '2026-05-04', '2026-05-10'), true);
    assert.equal(isTaskVisibleInWeek(row({ type: 'meeting', date: '2026-05-02', calendar: { ...calendar, timing: { ...calendar.timing, endDate: '2026-05-04' } } }), '2026-05-04', '2026-05-10'), false);
    assert.equal(isTaskVisibleInWeek(row({ type: 'meeting', date: '2026-05-05', calendar: { ...calendar, recurringMaster: true } }), '2026-05-04', '2026-05-10'), false);
});
