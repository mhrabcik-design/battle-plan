/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentMonthKey, monthKeyToDate, monthKeyToOffset } from './workLogMonth.ts';

test('month navigation crosses year boundaries without drifting', () => {
    const december = new Date(2026, 11, 15, 12);

    assert.equal(currentMonthKey(0, december), '2026-12');
    assert.equal(currentMonthKey(1, december), '2027-01');
    assert.equal(currentMonthKey(-12, december), '2025-12');
    assert.equal(monthKeyToOffset('2027-01', december), 1);
    assert.equal(monthKeyToOffset('2025-12', december), -12);
    assert.deepEqual(monthKeyToDate('2027-01'), new Date(2027, 0, 1));
});
