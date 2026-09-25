import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '../db.ts';
import type { DriveJsonStore } from './driveJsonStore.ts';
import type { TaskDriveBackupPayload } from './taskDriveBackup.ts';
import { mergeTaskBackupSnapshots } from './taskBackupSnapshots.ts';
import { db } from '../db.ts';
import { mergeTasksFromDrive } from './taskMerge.ts';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
const { TaskDriveBackup } = await import('./taskDriveBackup.ts');

const task = (publicId: string, overrides: Partial<Task> = {}): Task => ({
    publicId, title: publicId, type: 'task', urgency: 2, status: 'pending', createdAt: 1, updatedAt: 1, ...overrides,
});
const snapshot = (tasks: Task[], timestamp = 1): TaskDriveBackupPayload => ({ timestamp, data: { tasks } });

function memoryStore() {
    const files: { id: string; name: string; payload: TaskDriveBackupPayload }[] = [];
    let corruptRead = false;
    let hideSnapshots = false;
    const drive: Pick<DriveJsonStore, 'init' | 'initWithStatus' | 'writeJsonFile' | 'readJsonFilesWithStatus' | 'readJsonFileByIdWithStatus'> = {
        init: async () => true,
        initWithStatus: async () => ({ code: 'ready', message: 'ready' }),
        writeJsonFile: async (name, payload, fileId, options) => {
            assert.equal(fileId, null);
            assert.equal(options?.createOnly, true);
            assert.equal(name, 'battle_plan_task_snapshot_v2.json');
            const id = String(files.length + 1);
            files.push({ id, name, payload: structuredClone(payload) as TaskDriveBackupPayload });
            return { fileId: id };
        },
        readJsonFilesWithStatus: async <T>(name: string) => {
            const found = files.filter(file => file.name === name && !(hideSnapshots && name === 'battle_plan_task_snapshot_v2.json'));
            return found.length ? { kind: 'loaded', files: found.map(file => ({ fileId: file.id, data: structuredClone(file.payload) as T })) }
                : { kind: 'missing-file' };
        },
        readJsonFileByIdWithStatus: async <T>(id: string) => {
            const file = files.find(file => file.id === id);
            return file ? { kind: 'loaded', fileId: id, data: structuredClone(corruptRead ? {} : file.payload) as T } : { kind: 'missing-file' };
        },
    };
    return { files, drive, corrupt: (value = true) => { corruptRead = value; }, hide: () => { hideSnapshots = true; } };
}

test('independent stale clients append concurrently and load both tasks and all legacy files', async () => {
    const store = memoryStore();
    store.files.push({ id: 'legacy-a', name: 'battle_plan_data.json', payload: snapshot([task('legacy-a')]) });
    store.files.push({ id: 'legacy-b', name: 'battle_plan_data.json', payload: snapshot([task('legacy-b')]) });
    const a = new TaskDriveBackup(store.drive);
    const b = new TaskDriveBackup(store.drive);
    await Promise.all([a.save({ tasks: [task('a')] }), b.save({ tasks: [task('b')] })]);
    const loaded = await a.load();
    assert.deepEqual(loaded?.data?.tasks?.map(row => row.publicId).sort(), ['a', 'b', 'legacy-a', 'legacy-b']);
    assert.equal(store.files.length, 4);
});

test('newer tombstone wins over a stale snapshot regardless of listing order', () => {
    const old = snapshot([task('a')]);
    const deleted = snapshot([task('a', { isDeleted: true, updatedAt: 20 })]);
    for (const publications of [[old, deleted], [deleted, old]]) {
        const result = mergeTaskBackupSnapshots(publications);
        assert.equal(result.data?.tasks?.length, 1);
        assert.equal(result.data?.tasks?.[0].isDeleted, true);
    }
});

test('equal content ignores device-local IDs, revisions and delivery metadata', () => {
    const first = task('a', { id: 1, effectSequence: 2, googleId: 'local-link-a' });
    const second = task('a', { id: 80, effectSequence: 3, googleId: 'local-link-b', protocolRevision: { revision_id: 'sha256:different', mutation_id: 'mutation', base_revision: null } });
    assert.equal(mergeTaskBackupSnapshots([snapshot([first]), snapshot([second])]).data?.tasks?.length, 1);
});

test('same-time contradictory task edits and identities fail closed', () => {
    assert.throws(() => mergeTaskBackupSnapshots([snapshot([task('a'), task('a', { title: 'Conflict' })])]), /stejně nových/);
    assert.throws(() => mergeTaskBackupSnapshots([snapshot([
        task('a', { suggestionOccurrenceKey: 'one' }), task('a', { suggestionOccurrenceKey: 'two', updatedAt: 2 }),
    ])]), /identity/);
    assert.throws(() => mergeTaskBackupSnapshots([snapshot([
        task('a', { suggestionOccurrenceKey: 'one', suggestionSubjectId: 'subject-a' }),
        task('b', { suggestionOccurrenceKey: 'one', suggestionSubjectId: 'subject-b', updatedAt: 2 }),
    ])]), /identity/);
});

test('occurrence aliases keep newest content and recover metadata for later portable edits', () => {
    const result = mergeTaskBackupSnapshots([snapshot([
        task('a', { suggestionOccurrenceKey: 'one', suggestionSubjectId: 'subject' }),
        task('b', { suggestionOccurrenceKey: 'one', suggestionSubjectId: 'subject', updatedAt: 2 }),
        task('a', { title: 'Latest', updatedAt: 3 }),
    ])]);
    assert.deepEqual(result.data?.tasks?.map(row => [row.publicId, row.title, row.suggestionOccurrenceKey]).sort(), [
        ['a', 'Latest', 'one'], ['b', 'Latest', 'one'],
    ]);
});

test('ambiguous legacy tasks survive separately without numeric ID deduplication', () => {
    const first = task('unused', { id: 1, publicId: undefined, title: 'First' });
    const second = { ...first, title: 'Other device' };
    const result = mergeTaskBackupSnapshots([snapshot([first, second, first])]);
    assert.equal(result.data?.tasks?.length, 2);
    assert.ok(result.data?.tasks?.every(row => !row.publicId));
});

test('publication success requires matching persisted bytes and filters secrets both ways', async () => {
    const store = memoryStore();
    const backup = new TaskDriveBackup(store.drive);
    await backup.save({ tasks: [], settings: [{ id: 'gemini_api_key', value: 'synthetic-secret' }, { id: 'gemini_model', value: 'model' }] });
    assert.equal(JSON.stringify(store.files).includes('synthetic-secret'), false);
    store.files.push({ id: 'legacy', name: 'battle_plan_data.json', payload: { timestamp: 0, data: { settings: [{ id: 'gemini_api_key', value: 'old-secret' }] } } });
    assert.equal(JSON.stringify(await backup.load()).includes('old-secret'), false);
    store.corrupt();
    await assert.rejects(backup.save({ tasks: [] }), /ověřit/);
});

test('malformed publication aborts the aggregate instead of returning partial data', () => {
    assert.throws(() => mergeTaskBackupSnapshots([snapshot([task('a')]), { data: { tasks: 'wrong' as unknown as Task[] } }]), /formát/);
});

test('direct verification cannot report success when the shared listing omits the publication', async () => {
    const store = memoryStore();
    store.files.push({ id: 'legacy', name: 'battle_plan_data.json', payload: snapshot([task('other')]) });
    store.hide();
    await assert.rejects(new TaskDriveBackup(store.drive).save({ tasks: [task('missing-from-list')] }), /společném seznamu/);
});

test('verification retries reuse the uploaded file and recover without accumulating snapshots', async () => {
    const store = memoryStore();
    const backup = new TaskDriveBackup(store.drive);
    const data = { tasks: [task('retry')] };
    store.corrupt();
    await assert.rejects(backup.save(data), /ověřit/);
    await assert.rejects(backup.save(data), /ověřit/);
    assert.equal(store.files.length, 1);
    store.corrupt(false);
    assert.ok(await backup.save(data));
    assert.equal(store.files.length, 1);
    assert.ok(await new TaskDriveBackup(store.drive).save(data));
    assert.equal(store.files.length, 1);
});

test('returning to an older preference publishes a new revision instead of reusing stale history', async () => {
    const store = memoryStore();
    const oldData = { tasks: [], settings: [{ id: 'ui_scale', value: '1' }] };
    store.files.push({ id: 'old', name: 'battle_plan_task_snapshot_v2.json', payload: { version: '2.0', timestamp: 1, data: oldData } });
    store.files.push({ id: 'newer', name: 'battle_plan_task_snapshot_v2.json', payload: { version: '2.0', timestamp: 2,
        data: { ...oldData, settings: [{ id: 'ui_scale', value: '1.2' }] } } });
    const backup = new TaskDriveBackup(store.drive);
    await backup.save(oldData);
    assert.equal(store.files.length, 3);
    assert.deepEqual((await backup.load())?.data?.settings, oldData.settings);
});

test('an intervening failed edit invalidates the previous successful publication cache', async (t) => {
    let now = 1;
    t.mock.method(Date, 'now', () => now);
    const store = memoryStore();
    const backup = new TaskDriveBackup(store.drive);
    const original = { tasks: [], settings: [{ id: 'ui_scale', value: '1' }] };
    const changed = { tasks: [], settings: [{ id: 'ui_scale', value: '1.2' }] };
    await backup.save(original);
    const read = store.drive.readJsonFilesWithStatus;
    store.drive.readJsonFilesWithStatus = async () => { throw new Error('offline'); };
    now = 2;
    await assert.rejects(backup.save(changed), /offline/);
    store.drive.readJsonFilesWithStatus = read;
    store.files.push({ id: 'remote', name: 'battle_plan_task_snapshot_v2.json', payload: { timestamp: 2, data: changed } });
    now = 3;
    await backup.save(original);
    assert.deepEqual((await backup.load())?.data?.settings, original.settings);
});

test('known conflicts fail before creating a permanent snapshot and a newer edit can recover', async () => {
    const store = memoryStore();
    store.files.push({ id: 'existing', name: 'battle_plan_task_snapshot_v2.json', payload: snapshot([task('a')]) });
    const backup = new TaskDriveBackup(store.drive);
    await assert.rejects(backup.save({ tasks: [task('a', { title: 'Conflicting edit' })] }), /stejně nových/);
    assert.equal(store.files.length, 1);
    assert.ok(await backup.save({ tasks: [task('a', { title: 'Newer edit', updatedAt: 2 })] }));
    assert.equal(store.files.length, 2);
});

test('legacy missing updatedAt keeps createdAt fallback and deletion ordering', () => {
    const legacy = task('a', { createdAt: 2 });
    delete (legacy as Partial<Task>).updatedAt;
    const result = mergeTaskBackupSnapshots([snapshot([legacy, task('a', { updatedAt: 3, isDeleted: true })])]);
    assert.equal(result.data?.tasks?.[0].isDeleted, true);
});

test('legacy effective timestamp remains compatible after import and republication', async () => {
    await db.tasks.clear();
    const legacy = task('legacy-time', { createdAt: 2 });
    delete (legacy as Partial<Task>).updatedAt;
    await mergeTasksFromDrive(mergeTaskBackupSnapshots([snapshot([legacy])]).data!.tasks!);
    const imported = await db.tasks.toArray();
    assert.equal(imported[0].updatedAt, 2);
    assert.doesNotThrow(() => mergeTaskBackupSnapshots([snapshot([legacy]), snapshot(imported, 3)]));
});

test('simultaneous preference changes converge deterministically without blocking task recovery', () => {
    const a = { timestamp: 1, data: { tasks: [task('a')], settings: [{ id: 'ui_scale', value: '1' }] } };
    const b = { timestamp: 1, data: { tasks: [task('b')], settings: [{ id: 'ui_scale', value: '1.2' }] } };
    const forward = mergeTaskBackupSnapshots([a, b]);
    const reverse = mergeTaskBackupSnapshots([b, a]);
    assert.deepEqual(forward, reverse);
    assert.equal(forward.data?.tasks?.length, 2);
    assert.deepEqual(forward.data?.settings, [{ id: 'ui_scale', value: '1.2' }]);
});

test('occurrence reducer output imports once on either device while preserving local identity', async () => {
    const publications = [snapshot([
        task('device-a', { suggestionOccurrenceKey: 'occ', suggestionSubjectId: 'subject' }),
        task('device-b', { suggestionOccurrenceKey: 'occ', suggestionSubjectId: 'subject', createdAt: 2, updatedAt: 2 }),
        task('device-a', { title: 'Latest', updatedAt: 3, isDeleted: true }),
    ])];
    const merged = mergeTaskBackupSnapshots(publications).data!.tasks!;
    for (const publicId of ['device-a', 'device-b']) {
        await db.tasks.clear();
        await db.tasks.add(task(publicId, { id: 10, suggestionOccurrenceKey: 'occ', suggestionSubjectId: 'subject', createdAt: publicId === 'device-b' ? 2 : 1 }));
        await mergeTasksFromDrive(merged);
        const rows = await db.tasks.toArray();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, 10);
        assert.equal(rows[0].publicId, publicId);
        assert.equal(rows[0].title, 'Latest');
        assert.equal(rows[0].isDeleted, true);
        assert.doesNotThrow(() => mergeTaskBackupSnapshots([...publications, snapshot(rows, 4)]));
    }
});
