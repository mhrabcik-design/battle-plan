import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { db, type WorkLog } from '../db.ts';
import { deleteWorkLog } from './workLogDeletion.ts';

beforeEach(async () => { await db.open(); });
afterEach(async () => { db.close(); await db.delete(); });
const work: WorkLog = { syncId: 'selected', date: '2026-09-25', projectId: 1, projectName: 'Test', people: 'Martin', hours: 1, source: 'manual', createdAt: 10, updatedAt: 10 };

test('ordinary deletion records identity durably and preserves independently identical work', async () => {
    const id = await db.workLogs.add({ ...work });
    await db.workLogs.add({ ...work, syncId: 'independent' });
    assert.equal(await deleteWorkLog(id), true);
    assert.deepEqual((await db.workLogs.toArray()).map(row => row.syncId), ['independent']);
    const tombstone = await db.workLogDeletionTombstones.get('selected');
    assert.equal(tombstone?.reason, 'user-deleted');
    assert.ok(tombstone!.deletedAt >= 10);
    assert.equal(await deleteWorkLog(id), false);
    assert.deepEqual(await db.workLogDeletionTombstones.toArray(), [tombstone]);
});

test('ordinary deletion rolls back when the journal cannot be written', async () => {
    const id = await db.workLogs.add({ ...work });
    const failWrite = (): never => { throw new Error('injected write failure'); };
    db.workLogDeletionTombstones.hook('creating', failWrite);
    try { await assert.rejects(deleteWorkLog(id), /injected write failure/); }
    finally { db.workLogDeletionTombstones.hook('creating').unsubscribe(failWrite); }
    assert.ok(await db.workLogs.get(id));
    assert.equal(await db.workLogDeletionTombstones.count(), 0);
});

test('ordinary deletion rolls back its journal when the row cannot be deleted', async () => {
    const id = await db.workLogs.add({ ...work });
    const failDelete = (): never => { throw new Error('injected delete failure'); };
    db.workLogs.hook('deleting', failDelete);
    try { await assert.rejects(deleteWorkLog(id), /injected delete failure/); }
    finally { db.workLogs.hook('deleting').unsubscribe(failDelete); }
    assert.ok(await db.workLogs.get(id));
    assert.equal(await db.workLogDeletionTombstones.count(), 0);
});

test('ordinary deletion preserves compatible prior tombstones and rejects contradictory repair identity', async () => {
    const id = await db.workLogs.add({ ...work });
    const tombstone = { syncId: 'selected', reason: 'user-deleted' as const, deletedAt: 9 };
    await db.workLogDeletionTombstones.put(tombstone);
    await deleteWorkLog(id);
    assert.deepEqual(await db.workLogDeletionTombstones.get('selected'), tombstone);
    const staleId = await db.workLogs.add({ ...work });
    await db.workLogDeletionTombstones.put({ syncId: 'selected', reason: 'confirmed-duplicate', deletedAt: 9, survivorSyncId: 'other', fingerprint: 'copy' });
    await assert.rejects(deleteWorkLog(staleId), /worklog-delete-tombstone-conflict/);
    assert.ok(await db.workLogs.get(staleId));
});
