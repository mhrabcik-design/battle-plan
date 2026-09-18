import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { db, type Task } from '../db.ts';

Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
});
const { applySemanticResult } = await import('./semanticEngine.ts');
const signedOut = { state: 'SIGNED_OUT', accessToken: null } as const;

beforeEach(() => db.tasks.clear());
after(() => db.close());

async function seedTask() {
    const task: Task = {
        title: 'Původní úkol', description: 'Zachovat popis', type: 'task', urgency: 2,
        status: 'pending', date: '2026-09-18', deadline: '2026-09-18', startTime: '15:00',
        subTasks: [{ id: 'old', title: 'Původní krok', completed: true }],
        suggestionSubjectId: 'subject', suggestionOccurrenceKey: 'occurrence',
        source: 'agent', agent_write_id: 'write-1', createdAt: 1, updatedAt: 1,
    };
    const id = await db.tasks.add(task);
    return (await db.tasks.get(id))!;
}

test('voice updates persist supplied subtasks and preserve omitted subtasks', async () => {
    const original = await seedTask();
    const subTasks = [...original.subTasks!, { id: 'new', title: 'Nový krok', completed: false }];
    await applySemanticResult({ subTasks }, original.id!, signedOut);
    assert.deepEqual((await db.tasks.get(original.id!))?.subTasks, subTasks);

    await applySemanticResult({ title: 'Nový název' }, original.id!, signedOut);
    assert.deepEqual((await db.tasks.get(original.id!))?.subTasks, subTasks);

    await applySemanticResult({ subTasks: [] }, original.id!, signedOut);
    assert.deepEqual((await db.tasks.get(original.id!))?.subTasks, []);
});

test('voice all-day update removes the stored time and returns preserved identity metadata', async () => {
    const original = await seedTask();
    const result = await applySemanticResult({ isAllDay: true }, original.id!, signedOut);
    const saved = (await db.tasks.get(original.id!))!;
    assert.equal(saved.startTime, undefined);
    assert.equal(saved.isAllDay, true);
    assert.equal(saved.description, original.description);
    assert.equal(saved.date, original.date);
    assert.equal(saved.createdAt, original.createdAt);
    assert.equal(saved.publicId, original.publicId);
    assert.equal(result?.result?.publicId, original.publicId);
    assert.equal(result?.result?.suggestionOccurrenceKey, original.suggestionOccurrenceKey);
    assert.equal(result?.result?.agent_write_id, original.agent_write_id);
});

test('voice update does not revive a missing or deleted task', async () => {
    assert.equal(await applySemanticResult({ title: 'Missing' }, 999, signedOut), null);
    assert.equal(await db.tasks.count(), 0);
    const original = await seedTask();
    await db.tasks.update(original.id!, { isDeleted: true });
    assert.equal(await applySemanticResult({ title: 'Deleted' }, original.id!, signedOut), null);
    assert.equal((await db.tasks.get(original.id!))?.title, original.title);
});
