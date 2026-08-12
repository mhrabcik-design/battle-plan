import test from 'node:test';
import assert from 'node:assert/strict';
import { getWeeklyReschedulePatch, snapWeeklyMinute } from './calendarUtils.ts';
import type { UnifiedTask } from '../types.ts';

const task = (overrides: Partial<UnifiedTask>): UnifiedTask => ({
    title: 'Položka',
    type: 'task',
    status: 'pending',
    urgency: 2,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
});

test('timed meeting stores the dropped block start and preserves duration', () => {
    assert.deepEqual(getWeeklyReschedulePatch(task({ type: 'meeting', date: '2026-08-12', startTime: '10:00', duration: 60 }), {
        date: '2026-08-13',
        lane: 'timed',
        blockTopMinutes: 14 * 60,
    }), { date: '2026-08-13', deadline: '2026-08-13', startTime: '14:00', isAllDay: false });
});

test('timed task stores the deadline at the dropped block end', () => {
    assert.deepEqual(getWeeklyReschedulePatch(task({ deadline: '2026-08-12', startTime: '15:00', duration: 120 }), {
        date: '2026-08-13',
        lane: 'timed',
        blockTopMinutes: 9 * 60,
    }), { date: '2026-08-13', deadline: '2026-08-13', startTime: '11:00', isAllDay: false });
});

test('all-day movement changes the day and removes time semantics', () => {
    assert.deepEqual(getWeeklyReschedulePatch(task({ deadline: '2026-08-12', isAllDay: true }), {
        date: '2026-08-14',
        lane: 'all-day',
    }), { date: '2026-08-14', deadline: '2026-08-14', startTime: undefined, isAllDay: true });
});

test('weekly minutes snap to quarter hours and clamp a full block into the day', () => {
    assert.equal(snapWeeklyMinute(8 * 60 + 8, 60), 8 * 60 + 15);
    assert.equal(snapWeeklyMinute(6 * 60, 60), 7 * 60);
    assert.equal(snapWeeklyMinute(19 * 60, 60), 18 * 60);
});
