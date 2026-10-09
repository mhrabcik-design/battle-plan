import assert from 'node:assert/strict';
import test from 'node:test';
import { getWorkLogRowIssues } from './workLogBatch.ts';

const row = { projectSelected: true, people: '', hours: '8,5', requirePeople: false };

test('work-log validation rejects missing and impossible civil dates', () => {
    for (const date of ['', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00']) {
        assert.ok(getWorkLogRowIssues({ ...row, date }).some(issue => issue.includes('datum')), date);
    }
    for (const date of ['2024-02-29', '2026-02-28', '2026-10-09']) {
        assert.deepEqual(getWorkLogRowIssues({ ...row, date }), [], date);
    }
});

test('future-date rejection is opt-in for the manual form', () => {
    assert.ok(getWorkLogRowIssues({ ...row, date: '2026-10-10', maxDate: '2026-10-09' }).length > 0);
    assert.deepEqual(getWorkLogRowIssues({ ...row, date: '2026-10-09', maxDate: '2026-10-09' }), []);
    assert.deepEqual(getWorkLogRowIssues({ ...row, date: '2026-10-10' }), [], 'voice and edit callers keep their existing date policy');
});

test('shared row validation retains optional people and explained crew hours', () => {
    assert.deepEqual(getWorkLogRowIssues({ ...row, date: '2026-10-09' }), []);
    assert.ok(getWorkLogRowIssues({ ...row, date: '2026-10-09', requirePeople: true }).includes('Doplň lidi.'));
    assert.deepEqual(getWorkLogRowIssues({
        date: '2026-10-09', people: 'Martin, Sergej, Pepa', hours: 30, peopleCount: 3, hoursPerPerson: 10,
    }), []);
    assert.ok(getWorkLogRowIssues({ ...row, date: '2026-10-09', hours: 30 }).length > 0);
});
