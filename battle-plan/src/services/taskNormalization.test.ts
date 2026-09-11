/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureTaskDeadline } from './taskNormalization.ts';

test('undated tasks get Friday of the local Monday–Sunday week', () => {
    for (const [year, month, day, expected] of [
        [2026, 9, 7, '2026-09-11'],
        [2026, 9, 11, '2026-09-11'],
        [2026, 9, 12, '2026-09-11'],
        [2026, 9, 13, '2026-09-11'],
        [2026, 12, 31, '2027-01-01'],
        [2027, 1, 3, '2027-01-01'],
        [2026, 3, 29, '2026-03-27'],
    ] as const) {
        const now = new Date(year, month - 1, day, 0, 15);
        const timestamp = now.getTime();
        const task = { type: 'task' as const, title: 'Zkontrolovat', date: '', deadline: '', startTime: '10:00' };
        const saved = ensureTaskDeadline(task, now);
        assert.equal(saved.deadline, expected);
        assert.equal(saved.date, expected);
        assert.equal(saved.startTime, '10:00');
        assert.equal(task.deadline, '');
        assert.equal(now.getTime(), timestamp);
    }
});

test('dates are preserved, mirrored or repaired without scheduling thoughts and meetings', () => {
    const now = new Date(2026, 8, 9, 12);
    for (const fields of [
        { deadline: '2026-09-18' },
        { date: '2026-09-18' },
        { date: '2026-09-18', deadline: 'invalid' },
    ]) {
        const saved = ensureTaskDeadline({ type: 'task', ...fields }, now);
        assert.equal(saved.date, '2026-09-18');
        assert.equal(saved.deadline, '2026-09-18');
    }
    const scheduled = { type: 'task' as const, date: '2026-09-08', deadline: '2026-09-18' };
    assert.deepEqual(ensureTaskDeadline(scheduled, now), scheduled);
    for (const invalid of [undefined, '', ' ', 'tomorrow', '2026-02-30']) {
        assert.equal(ensureTaskDeadline({ type: 'task', deadline: invalid }, now).deadline, '2026-09-11');
    }
    for (const type of ['thought', 'meeting'] as const) {
        const item = { type };
        assert.equal(ensureTaskDeadline(item, now), item);
    }
});
