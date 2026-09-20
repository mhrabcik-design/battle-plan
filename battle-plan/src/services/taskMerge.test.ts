/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db, type Task } from '../db.ts';
import { mergeTasksFromDrive } from './taskMerge.ts';

const task = (overrides: Partial<Task> = {}): Task => ({ title: 'Work', type: 'task', urgency: 2, status: 'pending', createdAt: 10, updatedAt: 10, ...overrides });

beforeEach(async () => {
    await db.agentProtocolEvents.clear();
    await db.agentProtocolEffects.clear();
    await db.agentProtocolOutbox.clear();
});

test('Drive IDs never replace unrelated local identities; matching publicId retains its local key', async () => {
    await db.tasks.clear();
    await db.tasks.add(task({ id: 1, publicId: 'task_local', title: 'Local' }));
    assert.equal(await mergeTasksFromDrive([task({ id: 1, publicId: 'task_remote', title: 'Remote', updatedAt: 20 })]), true);
    assert.equal((await db.tasks.get(1))?.title, 'Local');
    const remote = await db.tasks.where('publicId').equals('task_remote').first();
    assert.ok(remote?.id && remote.id !== 1);
    assert.ok(remote.protocolRevision);
    assert.equal(await db.agentProtocolEvents.count(), 1);
    assert.equal(await db.agentProtocolEffects.count(), 0, 'downloads do not echo Google writes');
    await mergeTasksFromDrive([task({ id: 90, publicId: 'task_remote', title: 'Removed', isDeleted: true, updatedAt: 30 })]);
    assert.equal((await db.tasks.get(remote.id))?.isDeleted, true);
    assert.equal(await db.tasks.count(), 2);
    await mergeTasksFromDrive([task({ id: 50, publicId: 'task_remote', title: 'Stale', updatedAt: 20 })]);
    assert.equal((await db.tasks.get(remote.id))?.title, 'Removed');
});

test('legacy snapshots cannot overwrite an identified row and repeated import is deterministic', async () => {
    await db.tasks.clear();
    await db.tasks.add(task({ id: 1, publicId: 'task_local', title: 'Local' }));
    const legacy = task({ id: 1, title: 'Legacy', updatedAt: 100 });
    await mergeTasksFromDrive([legacy]);
    const imported = (await db.tasks.toArray()).find((row) => row.title === 'Legacy');
    assert.match(imported?.publicId ?? '', /^task_legacy_/);
    assert.equal((await db.tasks.get(1))?.title, 'Local');
    assert.equal(await mergeTasksFromDrive([{ ...legacy }]), false);
    assert.equal(await db.tasks.count(), 2);
    await db.tasks.clear();
    await mergeTasksFromDrive([legacy]);
    assert.equal((await db.tasks.toArray())[0]?.publicId, imported?.publicId);
});

test('same suggestion converted on two devices merges by occurrence and imports unrelated tasks', async () => {
    await db.tasks.clear();
    const local = task({ id: 1, publicId: 'task_device_a', suggestionOccurrenceKey: 'socc_shared', suggestionSubjectId: 'subject_shared', title: 'Local conversion' });
    await db.tasks.add(local);
    const remote = task({ id: 1, publicId: 'task_device_b', suggestionOccurrenceKey: 'socc_shared', suggestionSubjectId: 'subject_shared', title: 'Newer conversion', updatedAt: 20, isDeleted: true });
    const unrelated = task({ id: 2, publicId: 'task_unrelated', title: 'Another cloud task' });

    assert.equal(await mergeTasksFromDrive([remote, unrelated]), true);
    const imported = (await db.tasks.get(1))!;
    assert.deepEqual({ ...imported, protocolRevision: undefined }, { ...remote, id: 1, publicId: 'task_device_a', protocolRevision: undefined });
    assert.ok(imported.protocolRevision);
    assert.equal((await db.tasks.where('publicId').equals('task_unrelated').first())?.title, 'Another cloud task');
    assert.equal(await db.tasks.count(), 2);
    assert.equal(await mergeTasksFromDrive([remote, unrelated]), false);
    assert.equal(await mergeTasksFromDrive([{ ...remote, updatedAt: 15, title: 'Stale conversion', isDeleted: false }]), false);
    assert.equal((await db.tasks.get(1))?.isDeleted, true);
    await mergeTasksFromDrive([task({ publicId: 'task_device_a', title: 'Later edit without suggestion metadata', updatedAt: 30 })]);
    assert.equal((await db.tasks.get(1))?.suggestionOccurrenceKey, 'socc_shared');
    assert.equal((await db.tasks.get(1))?.suggestionSubjectId, 'subject_shared');
});

test('conflicting suggestion subjects fail explicitly without overwriting either identity', async () => {
    await db.tasks.clear();
    const local = task({ id: 1, publicId: 'task_device_a', suggestionOccurrenceKey: 'socc_shared', suggestionSubjectId: 'subject_A' });
    await db.tasks.add(local);
    await assert.rejects(mergeTasksFromDrive([
        task({ publicId: 'task_unrelated', title: 'Must roll back' }),
        task({ publicId: 'task_device_b', suggestionOccurrenceKey: 'socc_shared', suggestionSubjectId: 'subject_B', updatedAt: 20 }),
    ]), /Konflikt identity návrhu/);
    assert.deepEqual(await db.tasks.toArray(), [local]);
    assert.equal(await db.agentProtocolEvents.count(), 0, 'later identity failure rolls back earlier import event');
    assert.equal(await db.agentProtocolOutbox.count(), 0);
});

test('publicId and occurrence cannot silently select two different local tasks', async () => {
    await db.tasks.clear();
    const first = task({ id: 1, publicId: 'task_a' });
    const second = task({ id: 2, publicId: 'task_b', suggestionOccurrenceKey: 'socc_B', suggestionSubjectId: 'subject_B' });
    await db.tasks.bulkAdd([first, second]);
    await assert.rejects(mergeTasksFromDrive([
        task({ publicId: 'task_a', suggestionOccurrenceKey: 'socc_B', suggestionSubjectId: 'subject_B', updatedAt: 20 }),
    ]), /Konflikt identity návrhu/);
    await assert.rejects(mergeTasksFromDrive([
        task({ publicId: 'task_b', suggestionOccurrenceKey: 'socc_other', suggestionSubjectId: 'subject_B', updatedAt: 20 }),
    ]), /Konflikt identity návrhu/);
    assert.deepEqual(await db.tasks.toArray(), [first, second]);
});
