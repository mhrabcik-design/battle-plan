import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getWeeklyResizePatch,
    getWeeklyEdgeDirection,
    getWeeklyEdgeDirectionAtPoint,
    getWeeklyReschedulePatch,
    isWeeklyScheduleNoop,
    shouldNavigateWeeklyEdge,
    snapWeeklyMinute,
} from './calendarUtils.ts';
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
    assert.equal(snapWeeklyMinute(20 * 60, 60), 19 * 60);
});

test('weekly no-op comparison uses the semantic task and meeting fields', () => {
    const scheduledTask = task({ deadline: '2026-08-12', startTime: '11:00', isAllDay: false });
    const meeting = task({ type: 'meeting', date: '2026-08-12', startTime: '11:00', isAllDay: false });
    assert.equal(isWeeklyScheduleNoop(scheduledTask, { date: '2026-08-12', deadline: '2026-08-12', startTime: '11:00', isAllDay: false }), true);
    assert.equal(isWeeklyScheduleNoop(meeting, { date: '2026-08-12', deadline: '2026-08-12', startTime: '11:00', isAllDay: false }), true);
    assert.equal(isWeeklyScheduleNoop(scheduledTask, { date: '2026-08-13', deadline: '2026-08-13', startTime: '11:00', isAllDay: false }), false);
    assert.equal(isWeeklyScheduleNoop(meeting, { date: '2026-08-13', deadline: '2026-08-13', startTime: '11:00', isAllDay: false }), false);
    assert.equal(isWeeklyScheduleNoop(task({ deadline: '2026-08-12', startTime: undefined, isAllDay: undefined }), {
        date: '2026-08-12', deadline: '2026-08-12', startTime: undefined, isAllDay: true,
    }), true);
});

test('weekly edge direction activates only inside the calendar edge zones', () => {
    assert.equal(getWeeklyEdgeDirection(99, 100, 900), null);
    assert.equal(getWeeklyEdgeDirection(100, 100, 900), -1);
    assert.equal(getWeeklyEdgeDirection(171, 100, 900), -1);
    assert.equal(getWeeklyEdgeDirection(172, 100, 900), -1);
    assert.equal(getWeeklyEdgeDirection(173, 100, 900), null);
    assert.equal(getWeeklyEdgeDirection(827, 100, 900), null);
    assert.equal(getWeeklyEdgeDirection(828, 100, 900), 1);
    assert.equal(getWeeklyEdgeDirection(900, 100, 900), 1);
    assert.equal(getWeeklyEdgeDirection(901, 100, 900), null);
});

test('weekly edge zones never overlap in a narrow calendar', () => {
    assert.equal(getWeeklyEdgeDirection(120, 100, 140), -1);
    assert.equal(getWeeklyEdgeDirection(121, 100, 140), 1);
});

test('weekly pointer exit is authoritative even before the next animation frame', () => {
    const viewport = { left: 100, right: 900, top: 50, bottom: 650 };

    assert.equal(getWeeklyEdgeDirectionAtPoint(890, 300, viewport), 1);
    assert.equal(getWeeklyEdgeDirectionAtPoint(500, 300, viewport), null);
});

test('weekly edge dwell navigates only while the pointer remains in the armed edge', () => {
    const viewport = { left: 100, right: 900, top: 50, bottom: 650 };
    const armedEdge = 1;

    assert.equal(shouldNavigateWeeklyEdge(armedEdge, getWeeklyEdgeDirectionAtPoint(890, 300, viewport)), true);
    assert.equal(shouldNavigateWeeklyEdge(armedEdge, getWeeklyEdgeDirectionAtPoint(500, 300, viewport)), false);
    assert.equal(shouldNavigateWeeklyEdge(armedEdge, getWeeklyEdgeDirectionAtPoint(890, 700, viewport)), false);
    assert.equal(shouldNavigateWeeklyEdge(armedEdge, -1), false);
});

test('meeting resize preserves its start and derives a snapped duration from the new bottom edge', () => {
    assert.deepEqual(getWeeklyResizePatch(task({
        type: 'meeting',
        date: '2026-08-12',
        startTime: '10:00',
        duration: 60,
        isAllDay: false,
    }), 11 * 60 + 23), {
        date: '2026-08-12',
        deadline: undefined,
        startTime: '10:00',
        isAllDay: false,
        duration: 90,
    });
});

test('task resize preserves its visual top and moves its semantic end', () => {
    const scheduledTask = task({
        deadline: '2026-08-12',
        startTime: '11:00',
        duration: 120,
        isAllDay: false,
    });

    const patch = getWeeklyResizePatch(scheduledTask, 12 * 60 + 2);

    assert.deepEqual(patch, {
        date: undefined,
        deadline: '2026-08-12',
        startTime: '12:00',
        isAllDay: false,
        duration: 180,
    });
    assert.equal((12 * 60) - patch.duration!, 9 * 60);
});

test('weekly resize enforces its minimum and calendar end boundary', () => {
    const meeting = task({ type: 'meeting', startTime: '10:00', duration: 60, isAllDay: false });
    assert.equal(getWeeklyResizePatch(meeting, 10 * 60 + 4).duration, 30);

    const lateMeeting = task({ type: 'meeting', startTime: '19:00', duration: 60, isAllDay: false });
    assert.deepEqual(getWeeklyResizePatch(lateMeeting, 21 * 60), {
        date: undefined,
        deadline: undefined,
        startTime: '19:00',
        isAllDay: false,
        duration: 60,
    });
});

test('weekly resize treats missing and zero duration as sixty minutes', () => {
    const missingDurationTask = task({ startTime: '11:00', duration: undefined, isAllDay: false });
    const zeroDurationTask = task({ startTime: '11:00', duration: 0, isAllDay: false });

    assert.equal(getWeeklyResizePatch(missingDurationTask, 12 * 60).duration, 120);
    assert.equal(getWeeklyResizePatch(zeroDurationTask, 12 * 60).duration, 120);
    assert.equal(isWeeklyScheduleNoop(missingDurationTask, getWeeklyResizePatch(missingDurationTask, 11 * 60)), true);
    assert.equal(isWeeklyScheduleNoop(zeroDurationTask, getWeeklyResizePatch(zeroDurationTask, 11 * 60)), true);
});

test('weekly movement omits duration while no-op comparison detects an explicit duration change', () => {
    const meeting = task({
        type: 'meeting',
        date: '2026-08-12',
        startTime: '10:00',
        duration: 60,
        isAllDay: false,
    });
    const movePatch = getWeeklyReschedulePatch(meeting, {
        date: '2026-08-13',
        lane: 'timed',
        blockTopMinutes: 12 * 60,
    });

    assert.equal('duration' in movePatch, false);
    assert.equal(isWeeklyScheduleNoop(meeting, {
        date: '2026-08-12',
        deadline: undefined,
        startTime: '10:00',
        isAllDay: false,
        duration: 60,
    }), true);
    assert.equal(isWeeklyScheduleNoop(meeting, {
        date: '2026-08-12',
        deadline: undefined,
        startTime: '10:00',
        isAllDay: false,
        duration: 90,
    }), false);
    assert.equal(isWeeklyScheduleNoop(meeting, getWeeklyResizePatch(meeting, 11 * 60)), true);
});
