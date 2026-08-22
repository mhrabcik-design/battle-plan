import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMonthCalendar,
    formatDateValue,
    getCalendarMonthStart,
    shiftCalendarMonth,
} from './monthCalendar.ts';

test('month calendar starts on Monday and always contains six complete weeks', () => {
    const days = buildMonthCalendar(new Date(2026, 7, 1), '', new Date(2026, 7, 22));

    assert.equal(days.length, 42);
    assert.equal(days[0].isoDate, '2026-07-27');
    assert.equal(days[41].isoDate, '2026-09-06');
    assert.equal(days.find((day) => day.isoDate === '2026-08-01')?.isCurrentMonth, true);
    assert.equal(days.find((day) => day.isoDate === '2026-07-31')?.isCurrentMonth, false);
});

test('month calendar identifies the selected day and today independently', () => {
    const days = buildMonthCalendar(new Date(2026, 7, 1), '2026-08-10', new Date(2026, 7, 22));

    assert.equal(days.find((day) => day.isoDate === '2026-08-10')?.isSelected, true);
    assert.equal(days.find((day) => day.isoDate === '2026-08-22')?.isToday, true);
    assert.equal(days.filter((day) => day.isSelected).length, 1);
    assert.equal(days.filter((day) => day.isToday).length, 1);
});

test('selected date controls the initially visible month and month navigation stays on day one', () => {
    assert.deepEqual(getCalendarMonthStart('2028-02-29', new Date(2026, 7, 22)), new Date(2028, 1, 1));
    assert.deepEqual(getCalendarMonthStart('', new Date(2026, 7, 22)), new Date(2026, 7, 1));
    assert.deepEqual(shiftCalendarMonth(new Date(2026, 11, 1), 1), new Date(2027, 0, 1));
});

test('date values are formatted for Czech display without UTC day drift', () => {
    assert.equal(formatDateValue('2026-08-05'), '5. srpna 2026');
    assert.equal(formatDateValue(''), 'Vybrat datum');
});
