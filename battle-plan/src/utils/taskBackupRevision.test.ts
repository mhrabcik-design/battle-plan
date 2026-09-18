/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveQuery } from 'dexie';
import { db, type Task } from '../db.ts';
import { readTaskBackupSnapshot, taskBackupRevision } from './taskBackupRevision.ts';

const task = (id: number): Task => ({ id, title: `Task ${id}`, type: 'task', urgency: 2, status: 'pending', createdAt: 1, updatedAt: 1 });

test('revision covers all payload fields and settings without depending on array or object order', () => {
    const rows = [task(1), task(2)];
    const settings = [{ id: 'b', value: '2' }, { id: 'a', value: '1' }];
    const before = taskBackupRevision(rows, settings);
    assert.equal(taskBackupRevision([...rows].reverse(), [...settings].reverse()), before);
    assert.equal(taskBackupRevision(rows.map((row) => Object.fromEntries(Object.entries(row).reverse()) as unknown as Task), settings), before);
    assert.notEqual(taskBackupRevision([{ ...rows[0], description: 'Edited without timestamp' }, rows[1]], settings), before);
    assert.notEqual(taskBackupRevision(rows, [{ id: 'a', value: 'changed' }, settings[0]]), before);
});

test('production live query observes task changes while no task list is mounted and observes settings', async () => {
    await db.tasks.clear();
    await db.settings.clear();
    const revisions: string[] = [];
    let resolveNext!: () => void;
    const changed = () => new Promise<void>((resolve) => { resolveNext = resolve; });
    const initial = changed();
    const subscription = liveQuery(readTaskBackupSnapshot).subscribe((value) => { revisions.push(value.revision); resolveNext(); });
    try {
        await initial;
        const afterTask = changed();
        await db.tasks.add(task(1));
        await afterTask;
        const afterSetting = changed();
        await db.settings.put({ id: 'gemini_model', value: 'new-model' });
        await afterSetting;
        assert.equal(new Set(revisions).size, 3);
        assert.equal((await readTaskBackupSnapshot()).data.tasks.length, 1);
    } finally {
        subscription.unsubscribe();
    }
});
