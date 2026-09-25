import { db, type WorkLogDeletionTombstone } from '../db.ts';

/** Delete one explicitly selected row and retain its portable identity forever.
 * The journal and row deletion must commit together, including in agent transactions.
 */
export async function deleteWorkLog(id: number): Promise<boolean> {
    return db.transaction('rw', [db.workLogs, db.workLogDeletionTombstones], async () => {
        const row = await db.workLogs.get(id);
        if (!row) return false;
        if (!row.syncId?.trim()) throw new Error('worklog-delete-missing-sync-id');
        const existing = await db.workLogDeletionTombstones.get(row.syncId);
        if (existing && (existing.reason !== 'user-deleted'
            || existing.survivorSyncId !== undefined || existing.fingerprint !== undefined
            || !Number.isFinite(existing.deletedAt))) {
            throw new Error('worklog-delete-tombstone-conflict');
        }
        const tombstone: WorkLogDeletionTombstone = existing ?? {
            syncId: row.syncId,
            reason: 'user-deleted',
            deletedAt: Date.now(),
        };
        await db.workLogDeletionTombstones.put(tombstone);
        await db.workLogs.delete(id);
        return true;
    });
}
