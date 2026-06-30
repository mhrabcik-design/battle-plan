/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyDateScopedExtraWorkers,
    buildRepeatedWorkLogEntries,
    derivePersonHourMetadata,
    getWorkLogRowIssues,
    hasExplainedPersonHours,
    previousWorkWeekDates,
} from '../utils/workLogBatch.ts';
import { sanitizeExtractedWorkLog } from './workLogExtractor.ts';

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

test('sanitizeExtractedWorkLog keeps invalid dates unresolved', () => {
    const result = sanitizeExtractedWorkLog({
        entries: [{
            projectName: 'Plaza',
            people: ['Martin'],
            totalHours: 8,
            date: 'tomorrowish',
        }],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.entries[0].date, '');
    assert.equal(result.data.needsConfirmation, true);
    assert.ok(result.data.confirmationReasons.some((reason) => reason.includes('platné datum')));
    assert.ok(getWorkLogRowIssues({
        projectSelected: true,
        date: result.data.entries[0].date,
        people: result.data.entries[0].people,
        hours: result.data.entries[0].hours,
    }).some((issue) => issue.includes('datum')));
});

test('sanitizeExtractedWorkLog marks missing people for confirmation', () => {
    const result = sanitizeExtractedWorkLog({
        entries: [{
            projectName: 'Plaza',
            people: [],
            totalHours: 8,
            date: '2026-06-30',
        }],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.entries[0].people, '');
    assert.equal(result.data.needsConfirmation, true);
    assert.ok(getWorkLogRowIssues({
        projectSelected: true,
        date: result.data.entries[0].date,
        people: result.data.entries[0].people,
        hours: result.data.entries[0].hours,
    }).some((issue) => issue.includes('lidi')));
});

test('sanitizeExtractedWorkLog keeps valid ISO dates unchanged', () => {
    const result = sanitizeExtractedWorkLog({
        projectName: 'Plaza',
        people: ['Martin'],
        totalHours: 8,
        date: '2026-06-29',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.entries[0].date, '2026-06-29');
});

test('derivePersonHourMetadata recomputes totals from people and per-person hours', () => {
    assert.deepEqual(
        derivePersonHourMetadata({
            people: 'Martin, Sergej, Sergejův bratr, Pracovník 1',
            hours: 30,
            hoursPerPerson: 10,
        }),
        {
            hours: 40,
            hoursPerPerson: 10,
            peopleCount: 4,
            calculationNote: '4 lidé × 10 h = 40 h',
        },
    );
});

test('derivePersonHourMetadata clears stale metadata for normal totals', () => {
    assert.deepEqual(
        derivePersonHourMetadata({
            people: 'Martin',
            hours: 8,
            hoursPerPerson: '',
        }),
        {
            hours: 8,
            hoursPerPerson: undefined,
            peopleCount: undefined,
            calculationNote: undefined,
        },
    );
});
