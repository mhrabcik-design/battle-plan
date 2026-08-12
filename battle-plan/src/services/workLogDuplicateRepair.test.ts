import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
    db,
    type Project,
    type WorkLog,
    type WorkLogDeletionTombstone,
} from '../db.ts';
import { findExactWorkLogDuplicateGroups } from '../utils/workLogSyncIdentity.ts';
import {
    confirmWorkLogDuplicateRepair,
    WorkLogDuplicateRepairStaleError,
} from './workLogDuplicateRepair.ts';

async function resetDb(): Promise<void> {
    db.close();
    await db.delete();
    await db.open();
}

afterEach(async () => {
    db.close();
    await db.delete();
});

const sharedFields: Omit<WorkLog, 'id' | 'syncId'> = {
    date: '2026-06-22',
    projectId: 1,
    projectName: 'Komerční Banka',
    people: 'Martin, Sergej, Sergejův bratr',
    hours: 30,
    source: 'voice',
    extractionBatchId: 'voice-20',
    createdAt: 20,
    updatedAt: 20,
};

async function removeSyncIdWithoutDexieHooks(id: number): Promise<void> {
    const transaction = db.backendDB().transaction('workLogs', 'readwrite');
    const store = transaction.objectStore('workLogs');
    const row = await new Promise<WorkLog>((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result as WorkLog);
        request.onerror = () => reject(request.error);
    });
    delete row.syncId;
    store.put(row);
    await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

test('confirmed repair keeps one row and removes only the previewed exact copies', async () => {
    await resetDb();
    const project: Project = {
        name: 'Komerční Banka', aliases: ['Komerční banka Plaza'], color: 'amber', isActive: true,
        createdAt: 1, updatedAt: 1,
    };
    const projectId = await db.projects.add(project);
    await db.workLogs.bulkAdd([
        { ...sharedFields, projectId, syncId: 'device-a' },
        { ...sharedFields, projectId, projectName: 'Komerční banka Plaza', syncId: 'device-b' },
        { ...sharedFields, projectId, syncId: 'device-c' },
        { ...sharedFields, projectId, syncId: 'device-d' },
        { ...sharedFields, projectId, syncId: 'distinct', description: 'Samostatná práce' },
    ]);
    const [preview] = findExactWorkLogDuplicateGroups(await db.workLogs.toArray());
    assert.ok(preview);
    const survivorSnapshot = structuredClone(preview.survivor);
    const projectSnapshot = structuredClone(await db.projects.get(projectId));
    const startedAt = Date.now();

    const result = await confirmWorkLogDuplicateRepair({
        fingerprint: preview.fingerprint,
        rowIds: preview.rows.map((row) => row.id),
    });
    const completedAt = Date.now();

    assert.equal(result.removed, 3);
    assert.equal(result.survivor.syncId, 'device-a');
    assert.deepEqual(result.removedSyncIds, ['device-b', 'device-c', 'device-d']);
    assert.equal((await db.workLogs.toArray()).length, 2);
    assert.equal((await db.workLogs.toArray()).reduce((sum, row) => sum + row.hours, 0), 60);
    assert.deepEqual(await db.workLogs.get(preview.survivor.id), survivorSnapshot);
    assert.deepEqual(await db.projects.get(projectId), projectSnapshot);
    const tombstones = await db.workLogDeletionTombstones.orderBy('syncId').toArray();
    assert.deepEqual(
        tombstones.map((tombstone) => ({
            syncId: tombstone.syncId,
            survivorSyncId: tombstone.survivorSyncId,
            fingerprint: tombstone.fingerprint,
            reason: tombstone.reason,
        })),
        ['device-b', 'device-c', 'device-d'].map((syncId) => ({
            syncId,
            survivorSyncId: 'device-a',
            fingerprint: preview.fingerprint,
            reason: 'confirmed-duplicate',
        })),
    );
    assert.ok(tombstones.every(({ deletedAt }) => deletedAt >= startedAt && deletedAt <= completedAt));
});

test('confirmed repair keeps the newest exact copy', async () => {
    await resetDb();
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'older', updatedAt: 20 },
        { ...sharedFields, syncId: 'newer', updatedAt: 21 },
    ]);
    const [preview] = findExactWorkLogDuplicateGroups(await db.workLogs.toArray());
    assert.ok(preview);

    const result = await confirmWorkLogDuplicateRepair({
        fingerprint: preview.fingerprint,
        rowIds: preview.rows.map((row) => row.id),
    });

    assert.equal(result.survivor.syncId, 'newer');
    assert.deepEqual((await db.workLogs.toArray()).map((row) => row.syncId), ['newer']);
});

test('confirmed repair reuses a matching tombstone when a stale copy reappears', async () => {
    await resetDb();
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'device-a' },
        { ...sharedFields, syncId: 'device-b' },
    ]);
    const [preview] = findExactWorkLogDuplicateGroups(await db.workLogs.toArray());
    assert.ok(preview);
    const existingTombstone: WorkLogDeletionTombstone = {
        syncId: 'device-b',
        survivorSyncId: 'device-a',
        fingerprint: preview.fingerprint,
        reason: 'confirmed-duplicate',
        deletedAt: 10,
    };
    await db.workLogDeletionTombstones.add(existingTombstone);

    const result = await confirmWorkLogDuplicateRepair({
        fingerprint: preview.fingerprint,
        rowIds: preview.rows.map((row) => row.id),
    });

    assert.equal(result.removed, 1);
    assert.deepEqual((await db.workLogs.toArray()).map((row) => row.syncId), ['device-a']);
    assert.deepEqual(await db.workLogDeletionTombstones.get('device-b'), existingTombstone);
});

test('confirmed repair rejects a conflicting prior tombstone without deleting rows', async () => {
    await resetDb();
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'device-a' },
        { ...sharedFields, syncId: 'device-b' },
    ]);
    const rowsBefore = await db.workLogs.orderBy('id').toArray();
    const [preview] = findExactWorkLogDuplicateGroups(rowsBefore);
    assert.ok(preview);
    await db.workLogDeletionTombstones.add({
        syncId: 'device-b',
        survivorSyncId: 'another-survivor',
        fingerprint: preview.fingerprint,
        reason: 'confirmed-duplicate',
        deletedAt: 10,
    });

    await assert.rejects(
        confirmWorkLogDuplicateRepair({
            fingerprint: preview.fingerprint,
            rowIds: preview.rows.map((row) => row.id),
        }),
        /worklog-duplicate-tombstone-conflict/,
    );
    assert.deepEqual(await db.workLogs.orderBy('id').toArray(), rowsBefore);
});

test('confirmed repair fails closed when the preview changed', async () => {
    await resetDb();
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'device-a' },
        { ...sharedFields, syncId: 'device-b' },
    ]);
    const [preview] = findExactWorkLogDuplicateGroups(await db.workLogs.toArray());
    assert.ok(preview);
    await db.workLogs.add({ ...sharedFields, syncId: 'device-c' });

    await assert.rejects(
        confirmWorkLogDuplicateRepair({
            fingerprint: preview.fingerprint,
            rowIds: preview.rows.map((row) => row.id),
        }),
        WorkLogDuplicateRepairStaleError,
    );
    assert.equal((await db.workLogs.toArray()).length, 3);
    assert.equal(await db.workLogDeletionTombstones.count(), 0);
});

test('confirmed repair fails closed when a removed row has no sync identity', async () => {
    await resetDb();
    const ids = await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'device-a' },
        { ...sharedFields, syncId: 'device-b' },
    ], { allKeys: true }) as number[];
    await removeSyncIdWithoutDexieHooks(ids[1]!);
    const rowsBefore = await db.workLogs.orderBy('id').toArray();
    const [preview] = findExactWorkLogDuplicateGroups(rowsBefore);
    assert.ok(preview);

    await assert.rejects(
        confirmWorkLogDuplicateRepair({
            fingerprint: preview.fingerprint,
            rowIds: preview.rows.map((row) => row.id),
        }),
        /worklog-duplicate-missing-sync-id/,
    );
    assert.deepEqual(await db.workLogs.orderBy('id').toArray(), rowsBefore);
    assert.equal(await db.workLogDeletionTombstones.count(), 0);
});

test('confirmed repair rolls back tombstones and deletions when a tombstone write fails', async () => {
    await resetDb();
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'device-a' },
        { ...sharedFields, syncId: 'device-b' },
        { ...sharedFields, syncId: 'device-c' },
    ]);
    const rowsBefore = await db.workLogs.orderBy('id').toArray();
    const [preview] = findExactWorkLogDuplicateGroups(rowsBefore);
    assert.ok(preview);
    let writes = 0;
    const failSecondWrite = (): void => {
        writes += 1;
        if (writes === 2) throw new Error('injected tombstone write failure');
    };
    db.workLogDeletionTombstones.hook('creating', failSecondWrite);
    try {
        await assert.rejects(
            confirmWorkLogDuplicateRepair({
                fingerprint: preview.fingerprint,
                rowIds: preview.rows.map((row) => row.id),
            }),
            /injected tombstone write failure/,
        );
    } finally {
        db.workLogDeletionTombstones.hook('creating').unsubscribe(failSecondWrite);
    }

    assert.deepEqual(await db.workLogs.orderBy('id').toArray(), rowsBefore);
    assert.deepEqual(
        await db.workLogDeletionTombstones.toArray(),
        [] as WorkLogDeletionTombstone[],
    );
});
