/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db, type Task } from '../db.ts';
import { mergeTasksFromDrive } from './taskMerge.ts';
import { newTaskMutationContext, TaskMutationService } from './taskMutations.ts';

const task = (overrides: Partial<Task> = {}): Task => ({ title: 'Work', type: 'task', urgency: 2, status: 'pending', createdAt: 10, updatedAt: 10, ...overrides });

test('an offline deletion older than the former retention limit still defeats a stale Drive import', async () => {
    await db.tasks.clear();
    const deletedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const live = task({ publicId: 'task_offline_deleted', createdAt: deletedAt - 1000, updatedAt: deletedAt - 1000 });
    const id = await db.tasks.add(live);
    const service = new TaskMutationService(db, { now: () => deletedAt });
    const deletion = await service.archiveTask({ localId: id, context: newTaskMutationContext('ui') });
    assert.equal(deletion.status, 'applied');

    assert.equal(await mergeTasksFromDrive([{ ...live, id: 999 }]), false);
    const rows = await db.tasks.toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].isDeleted, true);
    assert.equal(rows[0].updatedAt, deletedAt);
    assert.equal(await mergeTasksFromDrive([live]), false, 'repeated stale imports preserve deletion');
});

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

test('metadata-only Drive recovery preserves local content and domain revision, including suppression generation', async () => {
    await db.tasks.clear();
    const local = task({ publicId: 'task_calendar', title: 'Local content', internalNotes: 'Keep private', updatedAt: 50 });
    await db.tasks.add(local);
    const calendar = { accountId: 'a', calendarId: 'primary', eventId: 'e0', canonicalIdentity: 'public:task_calendar', origin: 'local' as const, generation: 0, metadataUpdatedAt: 1 };
    assert.equal(await mergeTasksFromDrive([{ ...local, title: 'Stale cloud', updatedAt: 10, calendar }]), true);
    assert.equal((await db.tasks.toArray())[0].title, 'Local content');
    assert.equal(await db.agentProtocolEvents.count(), 0);
    const suppressed = { ...calendar, suppressed: true, metadataUpdatedAt: 2 };
    assert.equal(await mergeTasksFromDrive([{ ...local, calendar: suppressed }]), true);
    const restored = { ...calendar, eventId: 'e1', generation: 1, metadataUpdatedAt: 3 };
    assert.equal(await mergeTasksFromDrive([{ ...local, calendar: restored }]), true);
    assert.equal(await mergeTasksFromDrive([{ ...local, calendar: suppressed }]), false);
    const result = (await db.tasks.toArray())[0];
    assert.equal(result.calendar?.eventId, 'e1');
    assert.equal(result.calendar?.suppressed, undefined);
    assert.equal(result.internalNotes, 'Keep private');
    assert.equal(result.updatedAt, 50);
    assert.equal(await db.agentProtocolEffects.count(), 0);
});

test('Drive rejects a conflicting portable Calendar target before replacing a local legacy reservation', async () => {
    await db.tasks.clear();
    const local = task({ publicId: 'task_reserved', reservedGoogleEventId: 'local-target', googleAccountId: 'a' });
    await db.tasks.add(local);
    await assert.rejects(mergeTasksFromDrive([{ ...local, calendar: { accountId: 'a', calendarId: 'primary', eventId: 'other-target', canonicalIdentity: 'public:task_reserved', origin: 'local', generation: 0, metadataUpdatedAt: 2 } }]), /Calendar pairing/);
    assert.equal((await db.tasks.toArray())[0].reservedGoogleEventId, 'local-target');
    assert.equal(await db.agentProtocolEffects.count(), 0);
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
