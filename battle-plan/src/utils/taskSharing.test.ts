import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UnifiedTask } from '../types.ts';
import { buildTaskEmail } from './taskSharing.ts';

const base: UnifiedTask = {
    title: 'Příprava & kontrola #1', type: 'task', urgency: 2,
    status: 'pending', createdAt: 1, updatedAt: 1,
    internalNotes: 'SOUKROMÝ ZÁPIS',
};

test('email formatter shares public task content with the correct scheduling semantics', () => {
    const cases: { name: string; changes: Partial<UnifiedTask>; includes: string[]; excludes?: string[] }[] = [
        { name: 'timed meeting', changes: { type: 'meeting', date: '2026-09-25', startTime: '14:30', duration: 45,
            description: 'První řádek & #\nDruhý řádek\rTřetí řádek\r\nČtvrtý řádek',
            subTasks: [{ id: '1', title: 'Hotovo', completed: true }, { id: '2', title: 'Zbývá', completed: false }], progress: 50 },
            includes: ['Datum: 2026-09-25', 'Začátek: 14:30', 'Délka: 45 min', 'Pokrok: 50%', '✅ Hotovo', '☐ Zbývá',
                'První řádek & #\r\nDruhý řádek\r\nTřetí řádek\r\nČtvrtý řádek'], excludes: ['Čas dokončení:'] },
        { name: 'task completion time', changes: { deadline: '2026-09-26', startTime: '16:00', duration: 90, progress: 0 },
            includes: ['Termín: 2026-09-26', 'Čas dokončení: 16:00', 'Délka: 90 min', 'Pokrok: 0%'], excludes: ['Začátek:'] },
        { name: 'all-day meeting ignores stale time fields', changes: { type: 'meeting', date: '2026-09-27', isAllDay: true, startTime: '09:00', duration: 60 },
            includes: ['Datum: 2026-09-27', 'Celodenní'], excludes: ['09:00', 'Délka:', 'Začátek:'] },
        { name: 'missing values', changes: {}, includes: [base.title],
            excludes: ['Datum:', 'Termín:', 'Začátek:', 'Čas dokončení:', 'Délka:', 'Pokrok:', 'Neurčeno', 'Bez popisu'] },
        { name: 'Google Task', changes: { isGoogleTask: true, deadline: '2026-09-28', description: 'Google poznámka', startTime: '09:00', duration: 30 },
            includes: ['Termín: 2026-09-28', 'Google poznámka'], excludes: ['Čas dokončení:', 'Délka:'] },
        { name: 'note', changes: { type: 'note', description: 'Veřejná poznámka' }, includes: ['Veřejná poznámka'] },
        { name: 'thought', changes: { type: 'thought', description: 'Veřejná myšlenka' }, includes: ['Veřejná myšlenka'] },
    ];
    for (const { name, changes, includes, excludes = [] } of cases) {
        const task = { ...base, ...changes };
        const original = structuredClone(task);
        const result = buildTaskEmail(task);
        for (const value of includes) assert.ok(result.body.includes(value), `${name}: missing ${value}`);
        for (const value of [...excludes, 'SOUKROMÝ ZÁPIS', 'INTERNÍ ZÁPIS']) assert.ok(!result.body.includes(value), `${name}: leaked ${value}`);
        assert.doesNotMatch(result.body, /(?<!\r)\n|\r(?!\n)/);
        const query = new URL(result.mailto).searchParams;
        assert.equal(query.get('subject'), result.subject);
        assert.equal(query.get('body'), result.body);
        assert.equal([...query.keys()].length, 2);
        assert.deepEqual(task, original);
    }
});

test('email subject cannot introduce headers and long content is not truncated', () => {
    const description = 'Český text & #\n'.repeat(10000);
    const result = buildTaskEmail({ ...base, title: 'Název\r\nBcc: nikdo@example.com', description });
    assert.doesNotMatch(result.subject, /[\r\n]/);
    assert.ok(result.body.includes(description.replace(/\n/g, '\r\n')));
    assert.equal(new URL(result.mailto).searchParams.get('body'), result.body);
});
