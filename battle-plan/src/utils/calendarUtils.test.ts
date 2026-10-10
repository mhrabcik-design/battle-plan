import test from 'node:test';
import assert from 'node:assert/strict';
import {
    canResizeWeeklyTask,
    formatTimeLeft,
    getDeadlineColor,
    getAvailableWorkingMinutes,
    getWeekDays,
    parseDuration,
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

test('week dates and today marker follow the explicit local clock across midnight', () => {
    const sunday = getWeekDays(0, new Date(2026, 9, 11, 23, 59));
    const monday = getWeekDays(0, new Date(2026, 9, 12, 0, 1));
    assert.equal(sunday[0].full, '2026-10-05');
    assert.equal(sunday.find(day => day.isToday)?.full, '2026-10-11');
    assert.equal(monday[0].full, '2026-10-12');
    assert.equal(monday.find(day => day.isToday)?.full, '2026-10-12');
    const thursday = getWeekDays(0, new Date(2026, 9, 8, 23, 59));
    const friday = getWeekDays(0, new Date(2026, 9, 9, 0, 1));
    assert.equal(thursday[0].full, friday[0].full);
    assert.equal(thursday.find(day => day.isToday)?.full, '2026-10-08');
    assert.equal(friday.find(day => day.isToday)?.full, '2026-10-09');
});

test('week offsets remain civil dates through DST and a year boundary', () => {
    const afterDst = getWeekDays(0, new Date(2026, 9, 26, 0, 1));
    assert.equal(afterDst[0].full, '2026-10-26');
    assert.equal(afterDst[6].full, '2026-11-01');
    assert.equal(getWeekDays(-1, new Date(2026, 9, 26, 0, 1))[0].full, '2026-10-19');
    assert.equal(getWeekDays(1, new Date(2026, 11, 31, 23, 59))[0].full, '2027-01-04');
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
    }), 11 * 60 + 23)!, {
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

    const patch = getWeeklyResizePatch(scheduledTask, 12 * 60 + 2)!;

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
    assert.equal(getWeeklyResizePatch(meeting, 10 * 60 + 4)!.duration, 30);

    const lateMeeting = task({ type: 'meeting', startTime: '19:00', duration: 60, isAllDay: false });
    assert.deepEqual(getWeeklyResizePatch(lateMeeting, 21 * 60), {
        date: undefined,
        deadline: undefined,
        startTime: '19:00',
        isAllDay: false,
        duration: 60,
    });

    const tooLateMeeting = task({ type: 'meeting', startTime: '19:45', duration: 15, isAllDay: false });
    assert.equal(canResizeWeeklyTask(tooLateMeeting), false);
    assert.equal(getWeeklyResizePatch(tooLateMeeting, 20 * 60), null);
});

test('weekly resize follows the visible bottom edge for intervals clipped before 07:00', () => {
    const earlyMeeting = task({ type: 'meeting', startTime: '06:30', duration: 60, isAllDay: false });
    const earlyTask = task({ deadline: '2026-08-12', startTime: '07:30', duration: 120, isAllDay: false });

    assert.deepEqual(getWeeklyResizePatch(earlyMeeting, 8 * 60), {
        date: undefined,
        deadline: undefined,
        startTime: '06:30',
        isAllDay: false,
        duration: 90,
    });
    assert.deepEqual(getWeeklyResizePatch(earlyTask, 8 * 60), {
        date: undefined,
        deadline: '2026-08-12',
        startTime: '08:00',
        isAllDay: false,
        duration: 150,
    });
});

test('weekly resize treats missing and zero duration as sixty minutes', () => {
    const missingDurationTask = task({ startTime: '11:00', duration: undefined, isAllDay: false });
    const zeroDurationTask = task({ startTime: '11:00', duration: 0, isAllDay: false });

    assert.equal(getWeeklyResizePatch(missingDurationTask, 12 * 60)!.duration, 120);
    assert.equal(getWeeklyResizePatch(zeroDurationTask, 12 * 60)!.duration, 120);
    assert.equal(isWeeklyScheduleNoop(missingDurationTask, getWeeklyResizePatch(missingDurationTask, 11 * 60)!), true);
    assert.equal(isWeeklyScheduleNoop(zeroDurationTask, getWeeklyResizePatch(zeroDurationTask, 11 * 60)!), true);
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
    assert.equal(isWeeklyScheduleNoop(meeting, getWeeklyResizePatch(meeting, 11 * 60)!), true);
});


test('civil deadlines keep the local date across timezones and daylight saving transitions', () => {
    const previous = process.env.TZ;
    try {
        for (const zone of ['UTC', 'Europe/Prague', 'America/New_York']) {
            process.env.TZ = zone;
            for (const date of ['2026-10-03', '2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01']) {
                const now = new Date(`${date}T10:00:00`);
                assert.equal(formatTimeLeft(now, date, '15:00'), '5h 0m', `${zone} ${date}`);
                assert.equal(getAvailableWorkingMinutes(now, date, '15:00'), 300, `${zone} ${date}`);
                assert.equal(getDeadlineColor(now, date, '15:00'), 'text-amber-400', `${zone} ${date}`);
            }
        }
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});

test('invalid deadline dates and times have neutral output', () => {
    const now = new Date(2026, 9, 3, 10);
    for (const [date, time] of [['2026-10-03', '1'], ['2026-10-03', '25:00'], ['2026-10-03', '12:99'], ['2026-02-30', '15:00'], ['not-a-date', '15:00']]) {
        assert.equal(formatTimeLeft(now, date, time), '');
        assert.equal(getDeadlineColor(now, date, time), 'text-slate-500');
        assert.equal(getAvailableWorkingMinutes(now, date, time), 0);
    }
});

test('moving blocks longer than the viewport preserves duration and valid semantic times', () => {
    const target = { date: '2026-10-03', lane: 'timed' as const, blockTopMinutes: 9 * 60 };
    for (const type of ['meeting', 'task'] as const) {
        const original = task({ type, duration: 1500, startTime: '09:00' });
        const patch = getWeeklyReschedulePatch(original, target);
        assert.equal(patch.startTime, type === 'meeting' ? '07:00' : '20:00');
        assert.equal({ ...original, ...patch }.duration, 1500);
    }
    assert.equal(snapWeeklyMinute(9 * 60, 1500), 7 * 60);
});

test('duration parsing consumes the complete supported input', () => {
    for (const [input, minutes] of [['2h 30m', 150], ['2:30', 150], ['2,5h', 150], ['90m', 90], ['90', 90]] as const) {
        assert.equal(parseDuration(input), minutes, input);
    }
    for (const input of ['-2h', '1.5m', '2h later', 'x90m', '2h 3h', '0', '0h', '0:00', 'NaN']) {
        assert.equal(parseDuration(input), null, input);
    }
});
