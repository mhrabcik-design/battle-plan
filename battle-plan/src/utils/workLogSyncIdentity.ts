import type { WorkLog } from '../db';

type WorkLogIdentityFields = Pick<
    WorkLog,
    'syncId' | 'date' | 'projectName' | 'people' | 'createdAt' | 'updatedAt' | 'extractionBatchId'
>;

const normalize = (value: string | undefined): string =>
    (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export const getSyncTimestamp = (
    value: Pick<WorkLog, 'createdAt' | 'updatedAt'>,
): number => value.updatedAt ?? value.createdAt ?? 0;

const stableWorkLogContent = (workLog: WorkLog): unknown[] => [
    workLog.createdAt,
    workLog.date,
    normalize(workLog.projectName),
    normalize(workLog.people),
    workLog.hours,
    workLog.hoursPerPerson ?? null,
    workLog.peopleCount ?? null,
    workLog.calculationNote ?? null,
    workLog.assumptions ?? null,
    workLog.extractionBatchId ?? null,
    workLog.description ?? null,
    workLog.source,
    workLog.agent_write_id ?? null,
];

const duplicateWorkLogContent = (workLog: WorkLog): unknown[] => [
    workLog.createdAt,
    workLog.date,
    normalize(workLog.people),
    workLog.hours,
    workLog.hoursPerPerson ?? null,
    workLog.peopleCount ?? null,
    workLog.calculationNote ?? null,
    workLog.assumptions ?? null,
    workLog.extractionBatchId ?? null,
    workLog.description ?? null,
    workLog.source,
    workLog.agent_write_id ?? null,
];

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

export function createLegacyWorkLogSyncId(workLog: WorkLog): string {
    const value = JSON.stringify(stableWorkLogContent(workLog));
    let h1 = 1_779_033_703;
    let h2 = 3_144_134_277;
    let h3 = 1_013_904_242;
    let h4 = 2_773_480_762;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        h1 = h2 ^ Math.imul(h1 ^ code, 597_399_067);
        h2 = h3 ^ Math.imul(h2 ^ code, 2_869_860_233);
        h3 = h4 ^ Math.imul(h3 ^ code, 951_274_213);
        h4 = h1 ^ Math.imul(h4 ^ code, 2_716_044_179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597_399_067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951_274_213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2_716_044_179);
    const hex = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1]
        .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
        .join('');
    return `legacy-${hex}`;
}

/**
 * Conservative fallback used only when two devices assigned different sync IDs
 * to the same pre-sync WorkLog. It intentionally includes every user-visible
 * work field. The historical project-name snapshot is excluded because the
 * canonical project ID already identifies aliases merged by the user.
 */
export function getWorkLogDuplicateFingerprint(
    workLog: WorkLog,
    canonicalProjectId = workLog.projectId,
): string {
    return JSON.stringify([canonicalProjectId, ...duplicateWorkLogContent(workLog)]);
}

export interface ExactWorkLogDuplicateGroup {
    fingerprint: string;
    survivor: WorkLog & { id: number };
    rows: Array<WorkLog & { id: number }>;
    duplicateIds: number[];
}

/**
 * Finds rows that are indistinguishable by their persisted work content.
 * A match is only a repair candidate: distinct rows may intentionally have
 * identical content, so callers must obtain explicit user confirmation before
 * deleting anything.
 */
export function findExactWorkLogDuplicateGroups(
    workLogs: readonly WorkLog[],
): ExactWorkLogDuplicateGroup[] {
    const rowsByFingerprint = new Map<string, Array<WorkLog & { id: number }>>();

    for (const workLog of workLogs) {
        if (workLog.id == null) continue;
        const fingerprint = getWorkLogDuplicateFingerprint(workLog);
        const rows = rowsByFingerprint.get(fingerprint) ?? [];
        rows.push(workLog as WorkLog & { id: number });
        rowsByFingerprint.set(fingerprint, rows);
    }

    const groups: ExactWorkLogDuplicateGroup[] = [];
    for (const [fingerprint, rows] of rowsByFingerprint) {
        if (rows.length < 2) continue;
        const orderedRows = [...rows].sort((left, right) => {
            const freshness = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
            return freshness !== 0 ? freshness : left.id - right.id;
        });
        const survivor = orderedRows[0]!;
        groups.push({
            fingerprint,
            survivor,
            rows: orderedRows,
            duplicateIds: orderedRows.slice(1).map((row) => row.id),
        });
    }

    return groups.sort((left, right) => (
        right.rows.length - left.rows.length
        || left.survivor.date.localeCompare(right.survivor.date)
        || left.survivor.id - right.survivor.id
    ));
}

/** Normalize one snapshot before combining snapshots or looking up local rows.
 * Occurrence suffixes preserve identical rows captured in the same snapshot.
 * Existing portable identities are never reassigned by content similarity.
 */
function legacyPublicIdentities(rows: readonly WorkLog[]): Map<string, string> {
    const groups = new Map<string, { explicit: Set<string>; oldest: WorkLog }>();
    for (const row of rows) {
        if (!row.publicId) continue;
        let group = groups.get(row.publicId);
        if (!group) {
            group = { explicit: new Set(), oldest: row };
            groups.set(row.publicId, group);
        }
        if (row.syncId) group.explicit.add(row.syncId);
        const order = getSyncTimestamp(row) - getSyncTimestamp(group.oldest);
        if (order < 0 || (order === 0 && createLegacyWorkLogSyncId(row) < createLegacyWorkLogSyncId(group.oldest))) group.oldest = row;
    }
    const identities = new Map<string, string>();
    for (const [publicId, group] of groups) {
        // A public ID can anchor missing identities, never join conflicting
        // portable identities that have already been assigned.
        if (group.explicit.size > 1) throw new Error('Konflikt syncId pro historické WorkLog publicId.');
        identities.set(publicId, group.explicit.values().next().value ?? createLegacyWorkLogSyncId(group.oldest));
    }
    return identities;
}

export function normalizeLegacyWorkLogIdentities(workLogs: readonly WorkLog[], knownRows: readonly WorkLog[] = []): WorkLog[] {
    return normalizeLegacySnapshot(workLogs, legacyPublicIdentities([...knownRows, ...workLogs]));
}

export function normalizeLegacyWorkLogSnapshots(snapshots: readonly (readonly WorkLog[])[]): WorkLog[] {
    const identities = legacyPublicIdentities(snapshots.flat());
    return snapshots.flatMap(rows => normalizeLegacySnapshot(rows, identities));
}

function normalizeLegacySnapshot(workLogs: readonly WorkLog[], identities: ReadonlyMap<string, string>): WorkLog[] {
    const used = new Set(workLogs.flatMap(row => {
        const identity = row.syncId ?? (row.publicId ? identities.get(row.publicId) : undefined);
        return identity ? [identity] : [];
    }));
    const occurrences = new Map<string, number>();
    return workLogs.map(row => {
        if (row.syncId) return row;
        const knownIdentity = row.publicId ? identities.get(row.publicId) : undefined;
        if (knownIdentity) return { ...row, syncId: knownIdentity };
        const base = createLegacyWorkLogSyncId(row);
        let occurrence = (occurrences.get(base) ?? 0) + 1;
        let syncId = occurrence === 1 ? base : `${base}-${occurrence}`;
        while (used.has(syncId)) {
            occurrence++;
            syncId = `${base}-${occurrence}`;
        }
        occurrences.set(base, occurrence);
        used.add(syncId);
        return { ...row, syncId };
    });
}

function stableComparable(value: unknown, omittedKeys: ReadonlySet<string>): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => stableComparable(item, omittedKeys));
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([key, item]) => !omittedKeys.has(key) && item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stableComparable(item, omittedKeys)]),
    );
}

export const comparableWorkLog = (workLog: WorkLog): string => JSON.stringify(stableComparable(
    workLog,
    new Set(['id', 'projectId', 'publicId']),
));

export function mergeWorkLogSnapshots<T extends WorkLog>(
    localWorkLogs: T[],
    cloudWorkLogs: T[],
): T[] {
    const mergedByKey = new Map<string, T>();
    const conflicts = new Set<string>();
    for (const workLog of [...localWorkLogs, ...cloudWorkLogs]) {
        const key = getWorkLogSyncKey(workLog);
        const previous = mergedByKey.get(key);
        if (!previous || getSyncTimestamp(workLog) > getSyncTimestamp(previous)) {
            mergedByKey.set(key, workLog);
            conflicts.delete(key);
        } else if (getSyncTimestamp(workLog) === getSyncTimestamp(previous)
            && comparableWorkLog(workLog) !== comparableWorkLog(previous)) {
            conflicts.add(key);
        }
    }
    // A newer unambiguous version can supersede an older conflict regardless
    // of Drive listing order. Never choose between conflicting newest edits.
    if (conflicts.size) throw new Error('Konflikt stejně nových verzí WorkLog v zálohách.');
    return Array.from(mergedByKey.values());
}
