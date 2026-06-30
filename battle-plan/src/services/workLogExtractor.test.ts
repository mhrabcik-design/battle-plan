/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyDateScopedExtraWorkers,
    buildRepeatedWorkLogEntries,
    hasExplainedPersonHours,
    previousWorkWeekDates,
} from '../utils/workLogBatch.ts';

test('previousWorkWeekDates returns Monday through Friday for the prior week', () => {
    assert.deepEqual(
        previousWorkWeekDates(new Date(2026, 5, 30)),
        ['2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25', '2026-06-26'],
    );
});

test('buildRepeatedWorkLogEntries calculates person-hours for every date', () => {
    const entries = buildRepeatedWorkLogEntries({
        dates: ['2026-06-22', '2026-06-23'],
        projectName: 'Plaza',
        people: ['Martin', 'Sergej', 'Sergejův bratr'],
        hoursPerPerson: 10,
    });

    assert.equal(entries.length, 2);
    assert.equal(entries[0].hours, 30);
    assert.equal(entries[0].calculationNote, '3 lidé × 10 h = 30 h');
});

test('applyDateScopedExtraWorkers changes only the corrected date', () => {
    const entries = buildRepeatedWorkLogEntries({
        dates: ['2026-06-22', '2026-06-23', '2026-06-24'],
        projectName: 'Plaza',
        people: ['Martin', 'Sergej', 'Sergejův bratr'],
        hoursPerPerson: 10,
    });

    const corrected = applyDateScopedExtraWorkers(entries, '2026-06-24', 1);

    assert.equal(corrected[0].hours, 30);
    assert.equal(corrected[1].hours, 30);
    assert.equal(corrected[2].people, 'Martin, Sergej, Sergejův bratr, Pracovník 1');
    assert.equal(corrected[2].hours, 40);
});

test('hasExplainedPersonHours accepts explained person-hours above 24', () => {
    assert.equal(hasExplainedPersonHours(30, 3, 10), true);
});

test('hasExplainedPersonHours rejects unexplained totals above 24', () => {
    assert.equal(hasExplainedPersonHours(30, 1, undefined), false);
});
