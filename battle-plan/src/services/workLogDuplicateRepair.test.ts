import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { db, type WorkLog } from '../db.ts';
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

test('confirmed repair keeps one row and removes only the previewed exact copies', async () => {
    await resetDb();
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'device-a' },
        { ...sharedFields, projectName: 'Komerční banka Plaza', syncId: 'device-b' },
        { ...sharedFields, syncId: 'device-c' },
        { ...sharedFields, syncId: 'device-d' },
        { ...sharedFields, syncId: 'distinct', description: 'Samostatná práce' },
    ]);
    const [preview] = findExactWorkLogDuplicateGroups(await db.workLogs.toArray());
    assert.ok(preview);

    const result = await confirmWorkLogDuplicateRepair({
        fingerprint: preview.fingerprint,
        rowIds: preview.rows.map((row) => row.id),
    });

    assert.equal(result.removed, 3);
    assert.equal(result.survivor.syncId, 'device-a');
    assert.deepEqual(result.removedSyncIds, ['device-b', 'device-c', 'device-d']);
    assert.equal((await db.workLogs.toArray()).length, 2);
    assert.equal((await db.workLogs.toArray()).reduce((sum, row) => sum + row.hours, 0), 60);
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
});
