import { db, type WorkLog, type WorkLogDeletionTombstone } from '../db.ts';
import {
    findExactWorkLogDuplicateGroups,
    type ExactWorkLogDuplicateGroup,
} from '../utils/workLogSyncIdentity.ts';

export interface ConfirmWorkLogDuplicateRepairInput {
    fingerprint: string;
    rowIds: number[];
}

export interface WorkLogDuplicateRepairResult {
    survivor: WorkLog & { id: number };
    removed: number;
    removedSyncIds: string[];
}

export class WorkLogDuplicateRepairStaleError extends Error {
    constructor() {
        super('worklog-duplicate-preview-stale');
        this.name = 'WorkLogDuplicateRepairStaleError';
    }
}

class WorkLogDuplicateRepairMissingSyncIdError extends Error {
    constructor() {
        super('worklog-duplicate-missing-sync-id');
        this.name = 'WorkLogDuplicateRepairMissingSyncIdError';
    }
}

class WorkLogDuplicateRepairTombstoneConflictError extends Error {
    constructor() {
        super('worklog-duplicate-tombstone-conflict');
        this.name = 'WorkLogDuplicateRepairTombstoneConflictError';
    }
}

const sortedIds = (rows: Array<{ id: number }>): number[] => (
    rows.map((row) => row.id).sort((left, right) => left - right)
);

const sameIds = (left: readonly number[], right: readonly number[]): boolean => (
    left.length === right.length && left.every((id, index) => id === right[index])
);

/**
 * Deletes one user-confirmed exact-copy group. The preview is revalidated in
 * the same transaction so a sync or edit cannot widen the deletion silently.
 */
export async function confirmWorkLogDuplicateRepair(
    input: ConfirmWorkLogDuplicateRepairInput,
): Promise<WorkLogDuplicateRepairResult> {
    return db.transaction('rw', [db.workLogs, db.workLogDeletionTombstones], async () => {
        const groups = findExactWorkLogDuplicateGroups(await db.workLogs.toArray());
        const group: ExactWorkLogDuplicateGroup | undefined = groups.find(
            (candidate) => candidate.fingerprint === input.fingerprint,
        );
        const expectedIds = [...input.rowIds].sort((left, right) => left - right);
        if (!group || !sameIds(sortedIds(group.rows), expectedIds)) {
            throw new WorkLogDuplicateRepairStaleError();
        }

        const removedRows = group.rows.slice(1);
        const survivorSyncId = group.survivor.syncId;
        if (!survivorSyncId || removedRows.some((row) => !row.syncId)) {
            throw new WorkLogDuplicateRepairMissingSyncIdError();
        }
        const deletedAt = Date.now();
        const tombstones: WorkLogDeletionTombstone[] = removedRows.map((row) => ({
            syncId: row.syncId!,
            survivorSyncId,
            fingerprint: group.fingerprint,
            reason: 'confirmed-duplicate',
            deletedAt,
        }));
        const existingTombstones = await db.workLogDeletionTombstones.bulkGet(
            tombstones.map(({ syncId }) => syncId),
        );
        const durableTombstones = tombstones.map((tombstone, index) => {
            const existing = existingTombstones[index];
            if (!existing) return tombstone;
            if (
                existing.survivorSyncId !== tombstone.survivorSyncId
                || existing.fingerprint !== tombstone.fingerprint
                || existing.reason !== tombstone.reason
            ) {
                throw new WorkLogDuplicateRepairTombstoneConflictError();
            }
            return existing;
        });
        await db.workLogDeletionTombstones.bulkPut(durableTombstones);
        await db.workLogs.bulkDelete(group.duplicateIds);
        return {
            survivor: group.survivor,
            removed: group.duplicateIds.length,
            removedSyncIds: tombstones.map((tombstone) => tombstone.syncId),
        };
    });
}
