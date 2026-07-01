import type { WorkLog } from '../db';

type WorkLogIdentityFields = Pick<
    WorkLog,
    'syncId' | 'date' | 'projectName' | 'people' | 'createdAt' | 'updatedAt' | 'extractionBatchId'
>;

const normalize = (value: string | undefined): string =>
    (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const syncTimestamp = (workLog: WorkLogIdentityFields): number =>
    workLog.updatedAt ?? workLog.createdAt ?? 0;

export function createWorkLogSyncId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    return `wl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getWorkLogSyncKey(workLog: WorkLogIdentityFields): string {
    if (workLog.syncId) {
        return `sync:${workLog.syncId}`;
    }

    return [
        'legacy',
        workLog.extractionBatchId ?? '',
        workLog.createdAt ?? 0,
        workLog.date,
        normalize(workLog.projectName),
        normalize(workLog.people),
    ].join('|');
}

export function mergeWorkLogSnapshots<T extends WorkLogIdentityFields>(
    localWorkLogs: T[],
    cloudWorkLogs: T[],
): T[] {
    const mergedByKey = new Map<string, T>();

    for (const workLog of localWorkLogs) {
        mergedByKey.set(getWorkLogSyncKey(workLog), workLog);
    }

    for (const workLog of cloudWorkLogs) {
        const key = getWorkLogSyncKey(workLog);
        const local = mergedByKey.get(key);
        if (!local || syncTimestamp(workLog) > syncTimestamp(local)) {
            mergedByKey.set(key, workLog);
        }
    }

    return Array.from(mergedByKey.values());
}
