import {
    db,
    type WorkLog,
    type WorkLogDeletionTombstone,
    type Project,
} from '../db';
import { WORKLOGS_FILENAME } from './workLogsDriveMetadata';
import { getSyncTimestamp, getWorkLogSyncKey, mergeWorkLogSnapshots } from '../utils/workLogSyncIdentity';
import { DriveJsonStore, type DriveStoreStatus } from './driveJsonStore';
import { normalizeProjectName } from './projectCatalog';
import { getErrorMessage } from '../utils/errors';
import {
    buildProjectIdentityIndex,
    normalizeProjectAliases,
    ProjectIdentityConflictError,
    projectIdentityNames,
    reconcileProjectIdentities,
    resolveProjectIdentityFromIndex,
} from '../utils/projectIdentityReconciliation';

/**
 * WorkLogsSync — Drive I/O pro `work_logs_data.json` ve složce `/Anu-BattlePlan/`.
 *
 * Drive I/O mechaniku sdílí přes `DriveJsonStore`; payload a merge logika
 * zůstává tady.
 * - vše best-effort, chyby jen loguje (nevyhazují výjimky)
 *
 * F6 = merge logika: `mergeCloudToLocal()` porovná cloud vs IndexedDB
 * (updatedAt winner-wins), `mergeLocalToCloud()` odešle kompletní payload.
 */

interface WorkLogsFile {
    version?: number;
    last_updated?: number;
    workLogs: WorkLog[];
    projects: Project[];
    workLogDeletionTombstones?: WorkLogDeletionTombstone[];
}

interface WorkLogDeletionTombstonesFile {
    version: 1;
    last_updated: number;
    tombstones: WorkLogDeletionTombstone[];
}

const WORKLOG_TOMBSTONES_FILENAME = 'work_log_deletion_tombstones.json';
const MAX_SNAPSHOT_PUBLISH_ATTEMPTS = 3;

class WorkLogsStoreUnavailableError extends Error {
    readonly status: DriveStoreStatus;

    constructor(status: DriveStoreStatus) {
        super(status.message);
        this.name = 'WorkLogsStoreUnavailableError';
        this.status = status;
    }
}

class WorkLogsReadUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkLogsReadUnavailableError';
    }
}

export interface WorkLogsLoadData {
    workLogs: WorkLog[];
    projects: Project[];
    workLogDeletionTombstones: WorkLogDeletionTombstone[];
    timestamp: number;
}

export type WorkLogsLoadResult =
    | { kind: 'loaded'; data: WorkLogsLoadData }
    | { kind: 'missing-file'; data: WorkLogsLoadData }
    | { kind: 'store-unavailable'; status: DriveStoreStatus; data: WorkLogsLoadData }
    | { kind: 'error'; message: string; data: WorkLogsLoadData };

export type WorkLogsPublishResult =
    | { kind: 'published'; timestamp: number }
    | { kind: 'store-unavailable'; status: DriveStoreStatus; message: string }
    | { kind: 'read-unavailable'; message: string }
    | { kind: 'verification-failed'; message: string }
    | { kind: 'unexpected-error'; message: string };

const emptyWorkLogsLoadData = (): WorkLogsLoadData => ({
    workLogs: [],
    projects: [],
    workLogDeletionTombstones: [],
    timestamp: 0,
});

interface PublishedWorkLogsState {
    hasWorkLogsSnapshot: boolean;
    workLogs: WorkLog[];
    projects: Project[];
    journalTombstones: WorkLogDeletionTombstone[];
}

function parseWorkLogDeletionTombstone(value: unknown): WorkLogDeletionTombstone {
    if (!value || typeof value !== 'object') throw new Error('WorkLog tombstone nemá platný formát');
    const row = value as Partial<WorkLogDeletionTombstone>;
    if (
        typeof row.syncId !== 'string' || row.syncId.trim() === ''
        || typeof row.survivorSyncId !== 'string' || row.survivorSyncId.trim() === ''
        || row.syncId === row.survivorSyncId
        || typeof row.fingerprint !== 'string' || row.fingerprint === ''
        || row.reason !== 'confirmed-duplicate'
        || typeof row.deletedAt !== 'number' || !Number.isFinite(row.deletedAt)
    ) {
        throw new Error('WorkLog tombstone nemá platný formát');
    }
    return row as WorkLogDeletionTombstone;
}

function mergeWorkLogDeletionTombstones(
    ...snapshots: ReadonlyArray<readonly WorkLogDeletionTombstone[]>
): WorkLogDeletionTombstone[] {
    const bySyncId = new Map<string, WorkLogDeletionTombstone>();
    for (const snapshot of snapshots) {
        for (const raw of snapshot) {
            const tombstone = parseWorkLogDeletionTombstone(raw);
            const existing = bySyncId.get(tombstone.syncId);
            if (existing && (
                existing.survivorSyncId !== tombstone.survivorSyncId
                || existing.fingerprint !== tombstone.fingerprint
                || existing.reason !== tombstone.reason
            )) {
                throw new Error(`conflicting WorkLog tombstone: ${tombstone.syncId}`);
            }
            if (!existing || tombstone.deletedAt > existing.deletedAt) {
                bySyncId.set(tombstone.syncId, tombstone);
            }
        }
    }
    return [...bySyncId.values()].sort((left, right) => left.syncId.localeCompare(right.syncId));
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

const comparableWorkLog = (workLog: WorkLog): string => JSON.stringify(stableComparable(
    workLog,
    new Set(['id', 'projectId', 'publicId']),
));

const comparableProject = (project: Project): string => JSON.stringify({
    name: normalizeProjectName(project.name),
    aliases: normalizeProjectAliases(project.name, project.aliases).map(normalizeProjectName),
    color: project.color,
    isActive: project.isActive,
    updatedAt: project.updatedAt ?? project.createdAt ?? 0,
});

function matchingProjectIdentity(left: Project, right: Project): boolean {
    if (left.publicId && right.publicId && left.publicId === right.publicId) return true;
    const rightNames = new Set(projectIdentityNames(right).map(normalizeProjectName));
    return projectIdentityNames(left).some((name) => rightNames.has(normalizeProjectName(name)));
}

function containsUnambiguousVersion<T>(
    candidates: readonly T[],
    expected: T,
    timestamp: (value: T) => number,
    comparable: (value: T) => string,
): boolean {
    if (candidates.length === 0) return false;
    const latestTimestamp = Math.max(...candidates.map(timestamp));
    const latestStates = new Set(
        candidates
            .filter((candidate) => timestamp(candidate) === latestTimestamp)
            .map(comparable),
    );
    if (latestStates.size !== 1 || latestTimestamp < timestamp(expected)) return false;
    return latestTimestamp > timestamp(expected) || latestStates.has(comparable(expected));
}

function containsTombstones(
    published: readonly WorkLogDeletionTombstone[],
    expected: readonly WorkLogDeletionTombstone[],
): boolean {
    const bySyncId = new Map(published.map((tombstone) => [tombstone.syncId, tombstone]));
    return expected.every((target) => {
        const actual = bySyncId.get(target.syncId);
        return actual !== undefined
            && actual.survivorSyncId === target.survivorSyncId
            && actual.fingerprint === target.fingerprint
            && actual.reason === target.reason
            && actual.deletedAt >= target.deletedAt;
    });
}

function containsPublishedPayload(
    published: PublishedWorkLogsState,
    expected: {
        workLogs: readonly WorkLog[];
        projects: readonly Project[];
        tombstones: readonly WorkLogDeletionTombstone[];
    },
): boolean {
    if (!published.hasWorkLogsSnapshot || !containsTombstones(published.journalTombstones, expected.tombstones)) {
        return false;
    }
    const workLogsByKey = new Map<string, WorkLog[]>();
    for (const workLog of published.workLogs) {
        const key = getWorkLogSyncKey(workLog);
        const candidates = workLogsByKey.get(key);
        if (candidates) candidates.push(workLog);
        else workLogsByKey.set(key, [workLog]);
    }
    if (!expected.workLogs.every((workLog) => containsUnambiguousVersion(
        workLogsByKey.get(getWorkLogSyncKey(workLog)) ?? [],
        workLog,
        getSyncTimestamp,
        comparableWorkLog,
    ))) {
        return false;
    }
    return expected.projects.every((project) => containsUnambiguousVersion(
        published.projects.filter((candidate) => matchingProjectIdentity(candidate, project)),
        project,
        getSyncTimestamp,
        comparableProject,
    ));
}

type WorkLogsStore = Pick<
    DriveJsonStore,
    'init' | 'readJsonFilesWithStatus' | 'writeJsonFile' | 'lastStatus'
>;

export class WorkLogsSync {
    private isInitialized = false;
    private readonly drive: WorkLogsStore;

    constructor(drive: WorkLogsStore = new DriveJsonStore()) {
        this.drive = drive;
    }

    async init(): Promise<void> {
        if (this.isInitialized) return;
        this.isInitialized = await this.drive.init({ createFolder: true });
    }

    /**
     * Načte work_logs_data.json z Drive. Pokud neexistuje, vrátí prázdné pole.
     */
    async loadAll(): Promise<WorkLogsLoadData> {
        const result = await this.loadAllDetailed();
        return result.data;
    }

    async loadAllDetailed(): Promise<WorkLogsLoadResult> {
        if (!this.isInitialized) {
            return { kind: 'store-unavailable', status: this.drive.lastStatus, data: emptyWorkLogsLoadData() };
        }

        try {
            const [result, tombstoneResult] = await Promise.all([
                this.drive.readJsonFilesWithStatus<WorkLogsFile>(WORKLOGS_FILENAME),
                this.drive.readJsonFilesWithStatus<WorkLogDeletionTombstonesFile>(WORKLOG_TOMBSTONES_FILENAME),
            ]);
            if (tombstoneResult.kind === 'store-unavailable') return { ...tombstoneResult, data: emptyWorkLogsLoadData() };
            if (tombstoneResult.kind === 'error') return { ...tombstoneResult, data: emptyWorkLogsLoadData() };
            let remoteTombstones: WorkLogDeletionTombstone[] = [];
            let tombstoneTimestamp = 0;
            if (tombstoneResult.kind === 'loaded') {
                for (const file of tombstoneResult.files) {
                    remoteTombstones = mergeWorkLogDeletionTombstones(
                        remoteTombstones,
                        file.data.tombstones ?? [],
                    );
                    tombstoneTimestamp = Math.max(tombstoneTimestamp, file.data.last_updated ?? 0);
                }
            }
            if (result.kind === 'missing-file') {
                return {
                    kind: 'missing-file',
                    data: {
                        ...emptyWorkLogsLoadData(),
                        workLogDeletionTombstones: remoteTombstones,
                        timestamp: tombstoneTimestamp,
                    },
                };
            }
            if (result.kind === 'store-unavailable') return { ...result, data: emptyWorkLogsLoadData() };
            if (result.kind === 'error') return { ...result, data: emptyWorkLogsLoadData() };
            const [canonical] = result.files;
            if (!canonical) return { kind: 'missing-file', data: emptyWorkLogsLoadData() };
            const workLogs = mergeWorkLogSnapshots(
                [],
                result.files.flatMap((file) => file.data.workLogs ?? []),
            );
            const projects = result.files.flatMap((file) => file.data.projects ?? []);
            const tombstones = mergeWorkLogDeletionTombstones(
                remoteTombstones,
                ...result.files.map((file) => file.data.workLogDeletionTombstones ?? []),
            );
            const timestamp = result.files.reduce(
                (latest, file) => Math.max(latest, file.data.last_updated ?? 0),
                tombstoneTimestamp,
            );
            return {
                kind: 'loaded',
                data: {
                    workLogs,
                    projects,
                    workLogDeletionTombstones: tombstones,
                    timestamp,
                },
            };
        } catch (e) {
            console.error('WorkLogsSync: loadAll failed', e);
            return { kind: 'error', message: e instanceof Error ? e.message : String(e), data: emptyWorkLogsLoadData() };
        }
    }

    /**
     * Publikuje kompletní immutable snapshot a úspěch potvrdí až po rereadu
     * sjednoceného Drive stavu. Tombstone journal musí být ověřený jako první.
     */
    async saveAllDetailed(payload: {
        workLogs: WorkLog[];
        projects: Project[];
        workLogDeletionTombstones: WorkLogDeletionTombstone[];
    }): Promise<WorkLogsPublishResult> {
        if (!this.isInitialized) {
            return {
                kind: 'store-unavailable',
                status: this.drive.lastStatus,
                message: this.drive.lastStatus.message,
            };
        }

        const timestamp = Date.now();
        const tombstones = mergeWorkLogDeletionTombstones(payload.workLogDeletionTombstones);
        const fileContent = {
            version: 2,
            last_updated: timestamp,
            workLogs: payload.workLogs,
            projects: payload.projects,
            workLogDeletionTombstones: tombstones,
        };

        const expected = {
            workLogs: payload.workLogs,
            projects: payload.projects,
            tombstones,
        };

        try {
            let published = await this.readPublishedState();
            if (containsPublishedPayload(published, expected)) return { kind: 'published', timestamp };

            for (let attempt = 0; attempt < MAX_SNAPSHOT_PUBLISH_ATTEMPTS; attempt++) {
                if (tombstones.length > 0 && !containsTombstones(published.journalTombstones, tombstones)) {
                    await this.drive.writeJsonFile(
                        WORKLOG_TOMBSTONES_FILENAME,
                        { version: 1, last_updated: timestamp, tombstones } satisfies WorkLogDeletionTombstonesFile,
                        null,
                        { createOnly: true },
                    );
                    published = await this.readPublishedState();
                    if (!containsTombstones(published.journalTombstones, tombstones)) continue;
                    if (containsPublishedPayload(published, expected)) return { kind: 'published', timestamp };
                }

                await this.drive.writeJsonFile(
                    WORKLOGS_FILENAME,
                    fileContent,
                    null,
                    { createOnly: true },
                );
                published = await this.readPublishedState();
                if (containsPublishedPayload(published, expected)) return { kind: 'published', timestamp };
            }
            const message = 'Zápis WorkLogs snapshotu se nepodařilo ověřit';
            console.error('WorkLogsSync: saveAll failed', new Error(message));
            return { kind: 'verification-failed', message };
        } catch (e) {
            if (e instanceof WorkLogsStoreUnavailableError) {
                return { kind: 'store-unavailable', status: e.status, message: e.message };
            }
            if (e instanceof WorkLogsReadUnavailableError) {
                return { kind: 'read-unavailable', message: e.message };
            }
            console.error('WorkLogsSync: saveAll failed', e);
            return { kind: 'unexpected-error', message: getErrorMessage(e) };
        }
    }

    async saveAll(payload: {
        workLogs: WorkLog[];
        projects: Project[];
        workLogDeletionTombstones: WorkLogDeletionTombstone[];
    }): Promise<number | null> {
        const result = await this.saveAllDetailed(payload);
        return result.kind === 'published' ? result.timestamp : null;
    }

    private async readPublishedState(): Promise<PublishedWorkLogsState> {
        const [workLogsResult, tombstoneResult] = await Promise.all([
            this.drive.readJsonFilesWithStatus<WorkLogsFile>(WORKLOGS_FILENAME),
            this.drive.readJsonFilesWithStatus<WorkLogDeletionTombstonesFile>(WORKLOG_TOMBSTONES_FILENAME),
        ]);
        if (workLogsResult.kind === 'store-unavailable') {
            throw new WorkLogsStoreUnavailableError(workLogsResult.status);
        }
        if (workLogsResult.kind === 'error') {
            throw new WorkLogsReadUnavailableError(workLogsResult.message);
        }
        if (tombstoneResult.kind === 'store-unavailable') {
            throw new WorkLogsStoreUnavailableError(tombstoneResult.status);
        }
        if (tombstoneResult.kind === 'error') {
            throw new WorkLogsReadUnavailableError(tombstoneResult.message);
        }
        const workLogsFiles = workLogsResult.kind === 'loaded' ? workLogsResult.files : [];
        const tombstoneFiles = tombstoneResult.kind === 'loaded' ? tombstoneResult.files : [];
        const journalTombstones = mergeWorkLogDeletionTombstones(
            ...tombstoneFiles.map((file) => file.data.tombstones ?? []),
        );
        return {
            hasWorkLogsSnapshot: workLogsFiles.length > 0,
            workLogs: workLogsFiles.flatMap((file) => file.data.workLogs ?? []),
            projects: workLogsFiles.flatMap((file) => file.data.projects ?? []),
            journalTombstones,
        };
    }

    get initialized(): boolean {
        return this.isInitialized;
    }

    get status(): DriveStoreStatus {
        return this.drive.lastStatus;
    }
}

export const workLogsSync = new WorkLogsSync();

// === F6: Merge logika (cloud ↔ IndexedDB) ===

export interface MergeResult {
    workLogsAdded: number;
    workLogsUpdated: number;
    projectsAdded: number;
    projectsUpdated: number;
    workLogsRemoved: number;   // cloud-only záznamy, které nemáme v local → zahazujeme (přepíšeme z cloudu)
    projectsRemoved: number;
}

let workLogsSyncQueue: Promise<void> = Promise.resolve();

function enqueueWorkLogsSync<T>(operation: () => Promise<T>): Promise<T> {
    const result = workLogsSyncQueue.then(operation);
    workLogsSyncQueue = result.then(() => undefined, () => undefined);
    return result;
}

export function mergeCloudToLocal(
    cloudWorkLogs: WorkLog[],
    cloudProjects: Project[],
    cloudWorkLogDeletionTombstones: WorkLogDeletionTombstone[] = [],
): Promise<MergeResult> {
    return enqueueWorkLogsSync(() => performMergeCloudToLocal(
        cloudWorkLogs,
        cloudProjects,
        cloudWorkLogDeletionTombstones,
    ));
}

/**
 * Porovná cloud data s IndexedDB a provede winner-wins merge podle updatedAt.
 * Vrací statistiku. Side-effect: aktualizuje db.workLogs a db.projects.
 *
 * Logika:
 * 1. Pro každý cloud WorkLog:
 *    - pokud není v local → add
 *    - pokud je v local a cloud.updatedAt > local.updatedAt → put (aktualizuj)
 *    - jinak ponech local
 * 2. Pro každý cloud Project:
 *    - pokud není v local → add
 *    - pokud je v local a cloud.updatedAt > local.updatedAt → put
 * 3. Pro local WorkLogy/Projects, které nejsou v cloudu → ponecháme (merge je add/update only,
 *    delete nechá na userovi)
 *
 * Po merge se projekty sjednotí podle normalizovaného názvu a WorkLogy se přepojí
 * na lokální kanonický projectId. Historický projectName zůstává zachovaný.
 */
async function performMergeCloudToLocal(
    cloudWorkLogs: WorkLog[],
    cloudProjects: Project[],
    cloudWorkLogDeletionTombstones: WorkLogDeletionTombstone[] = [],
): Promise<MergeResult> {
    const result: MergeResult = {
        workLogsAdded: 0,
        workLogsUpdated: 0,
        projectsAdded: 0,
        projectsUpdated: 0,
        workLogsRemoved: 0,
        projectsRemoved: 0,
    };

    await db.transaction('rw', [db.workLogs, db.projects, db.workLogDeletionTombstones], async () => {
        const localTombstones = await db.workLogDeletionTombstones.toArray();
        const localTombstonesBySyncId = new Map(
            localTombstones.map((tombstone) => [tombstone.syncId, tombstone]),
        );
        const tombstones = mergeWorkLogDeletionTombstones(localTombstones, cloudWorkLogDeletionTombstones);
        const changedTombstones = tombstones.filter((tombstone) => {
            const local = localTombstonesBySyncId.get(tombstone.syncId);
            return !local || tombstone.deletedAt > local.deletedAt;
        });
        if (changedTombstones.length > 0) {
            await db.workLogDeletionTombstones.bulkPut(changedTombstones);
        }
        const deletedSyncIds = new Set(tombstones.map((tombstone) => tombstone.syncId));
        const staleLocalIds = deletedSyncIds.size > 0
            ? await db.workLogs.where('syncId').anyOf([...deletedSyncIds]).primaryKeys() as number[]
            : [];
        if (staleLocalIds.length > 0) {
            await db.workLogs.bulkDelete(staleLocalIds);
            result.workLogsRemoved += staleLocalIds.length;
        }
        const initialReconciliation = await reconcileProjectIdentities(db.projects, db.workLogs);
        result.projectsRemoved += initialReconciliation.projectsMerged;
        let localProjects = await db.projects.toArray();
        let identityIndex = buildProjectIdentityIndex(localProjects);
        let projectsChanged = false;

        // === Projects ===
        const projectsInStableOrder = [...cloudProjects].sort((left, right) => {
            const nameOrder = normalizeProjectName(left.name).localeCompare(normalizeProjectName(right.name));
            if (nameOrder !== 0) return nameOrder;
            if ((left.updatedAt ?? 0) !== (right.updatedAt ?? 0)) {
                return (left.updatedAt ?? 0) - (right.updatedAt ?? 0);
            }
            return (left.createdAt ?? 0) - (right.createdAt ?? 0);
        });
        for (const cp of projectsInStableOrder) {
            const normalizedName = normalizeProjectName(cp.name);
            const identity = resolveProjectIdentityFromIndex(identityIndex, cp.name);
            if (identity.outcome === 'conflict') {
                throw new ProjectIdentityConflictError(
                    `cloud project ${normalizedName} has conflicting local owners`,
                    [normalizedName],
                );
            }
            if (identity.outcome === 'missing') {
                const withoutId = { ...cp };
                delete withoutId.id;
                const aliases = normalizeProjectAliases(withoutId.name, withoutId.aliases);
                const project: Project = {
                    ...withoutId,
                    ...(aliases.length > 0 || withoutId.aliases !== undefined ? { aliases } : {}),
                    isActive: withoutId.isActive ?? true,
                    createdAt: withoutId.createdAt ?? Date.now(),
                    updatedAt: withoutId.updatedAt ?? Date.now(),
                };
                const id = await db.projects.add(project);
                localProjects.push({ ...project, id: id as number });
                identityIndex = buildProjectIdentityIndex(localProjects);
                projectsChanged = true;
                result.projectsAdded++;
            } else {
                const local = identity.project;
                const matchedCanonical = normalizeProjectName(local.name) === normalizedName;
                if (!matchedCanonical && projectIdentityNames(cp).some(
                    (name) => normalizeProjectName(name) === normalizeProjectName(local.name),
                )) {
                    throw new ProjectIdentityConflictError(
                        `cloud project ${normalizedName} creates an alias cycle`,
                        [normalizedName, normalizeProjectName(local.name)],
                    );
                }
                const cloudIsNewer = matchedCanonical && (cp.updatedAt ?? 0) > (local.updatedAt ?? 0);
                const nextName = cloudIsNewer ? cp.name : local.name;
                const aliases = normalizeProjectAliases(nextName, [
                    ...projectIdentityNames(local),
                    ...projectIdentityNames(cp),
                ]);
                const shouldPersistAliases = aliases.length > 0
                    || local.aliases !== undefined
                    || cp.aliases !== undefined;
                const aliasesChanged = shouldPersistAliases
                    && JSON.stringify(local.aliases) !== JSON.stringify(aliases);
                const changes: Partial<Project> = {
                    ...(cloudIsNewer ? {
                        name: cp.name,
                        color: cp.color,
                        isActive: cp.isActive,
                        updatedAt: cp.updatedAt ?? Date.now(),
                    } : aliasesChanged ? {
                        // Alias-only convergence must change App.tsx's live
                        // project hash so the union is published back to Drive.
                        // Use a deterministic logical timestamp so repeating
                        // the same payload becomes byte-stable.
                        updatedAt: Math.max(local.updatedAt ?? 0, cp.updatedAt ?? 0) + 1,
                    } : {}),
                    ...(shouldPersistAliases
                        ? { aliases }
                        : {}),
                };
                const hasChanges = Object.entries(changes).some(([key, value]) => (
                    JSON.stringify(local[key as keyof Project]) !== JSON.stringify(value)
                ));
                if (!hasChanges) continue;
                await db.projects.update(local.id!, changes);
                localProjects = localProjects.map((project) => (
                    project.id === local.id ? { ...local, ...changes } : project
                ));
                identityIndex = buildProjectIdentityIndex(localProjects);
                projectsChanged = true;
                result.projectsUpdated++;
            }
        }

        // Validate and collapse the complete identity graph before importing
        // WorkLogs. Any cycle or competing alias ownership rejects the Dexie
        // transaction, including the project writes above.
        if (projectsChanged) {
            const projectReconciliation = await reconcileProjectIdentities(db.projects, db.workLogs);
            result.projectsRemoved += projectReconciliation.projectsMerged;
            localProjects = await db.projects.toArray();
            identityIndex = buildProjectIdentityIndex(localProjects);
        }
        const localWorkLogsByCompositeKey = new Map<string, WorkLog>();
        for (const workLog of await db.workLogs.toArray()) {
            localWorkLogsByCompositeKey.set(getWorkLogSyncKey(workLog), workLog);
        }

        // === WorkLogs ===
        // Cloud project IDs are device-local. Resolve each imported row through
        // its normalized project snapshot before persisting it locally.
        let needsOrphanReconciliation = false;
        for (const cw of cloudWorkLogs) {
            if (cw.syncId && deletedSyncIds.has(cw.syncId)) continue;
            const key = getWorkLogSyncKey(cw);
            const identity = resolveProjectIdentityFromIndex(identityIndex, cw.projectName);
            if (identity.outcome === 'conflict') {
                // Reconciliation above normally makes this unreachable, but
                // retaining the guard prevents first-match attachment if a
                // malformed payload ever bypasses the graph validation.
                throw new Error(`conflicting project identity: ${normalizeProjectName(cw.projectName)}`);
            }
            const localProject = identity.outcome === 'resolved' ? identity.project : undefined;
            const resolvedProjectId = localProject?.id ?? -1;
            const local = localWorkLogsByCompositeKey.get(key);
            if (!local) {
                // Cloud-only → přidej (s novým ID)
                const withoutId = { ...cw };
                delete withoutId.id;
                const addedWorkLog: WorkLog = {
                    ...withoutId,
                    projectId: resolvedProjectId,
                    source: withoutId.source ?? 'voice',
                    createdAt: withoutId.createdAt ?? Date.now(),
                    updatedAt: withoutId.updatedAt ?? Date.now(),
                };
                const id = await db.workLogs.add(addedWorkLog);
                const storedWorkLog = { ...addedWorkLog, id: id as number };
                localWorkLogsByCompositeKey.set(getWorkLogSyncKey(storedWorkLog), storedWorkLog);
                needsOrphanReconciliation ||= localProject === undefined;
                result.workLogsAdded++;
            } else if ((cw.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
                // Cloud novější → update (zachováme local id)
                const changes: Partial<WorkLog> = {
                    ...cw,
                    id: local.id, // nepřepisujeme ID
                    projectId: localProject?.id ?? local.projectId,
                    createdAt: local.createdAt, // createdAt je posvátné
                    updatedAt: cw.updatedAt ?? Date.now(),
                };
                await db.workLogs.update(local.id!, changes);
                const updatedWorkLog: WorkLog = {
                    ...local,
                    ...changes,
                    publicId: local.publicId,
                    syncId: local.syncId,
                };
                localWorkLogsByCompositeKey.set(getWorkLogSyncKey(updatedWorkLog), updatedWorkLog);
                needsOrphanReconciliation ||= localProject === undefined;
                result.workLogsUpdated++;
            }
        }

        // Create reusable catalog rows only for true orphans. Alias snapshots
        // have already resolved to their survivor and retain their display text.
        if (needsOrphanReconciliation) {
            const reconciliation = await reconcileProjectIdentities(db.projects, db.workLogs);
            result.projectsAdded += reconciliation.projectsCreated;
            result.projectsRemoved += reconciliation.projectsMerged;
        }
    });

    return result;
}

/**
 * Odešle kompletní payload z IndexedDB do cloudu. Jednoduchý "celé to tam hoď" přístup.
 * Později (F7+) můžeme dělat deltas, ale pro F6 stačí celý payload.
 */
export interface MergeLocalToCloudOptions {
    excludedWorkLogSyncIds?: readonly string[];
}

async function performMergeLocalToCloudDetailed(
    options: MergeLocalToCloudOptions = {},
): Promise<WorkLogsPublishResult> {
    if (!workLogsSync.initialized) {
        await workLogsSync.init();
        if (!workLogsSync.initialized) {
            return {
                kind: 'store-unavailable',
                status: workLogsSync.status,
                message: workLogsSync.status.message,
            };
        }
    }
    const cloudResult = await workLogsSync.loadAllDetailed();
    if (cloudResult.kind === 'store-unavailable') {
        return {
            kind: 'store-unavailable',
            status: cloudResult.status,
            message: cloudResult.status.message,
        };
    }
    if (cloudResult.kind === 'error') {
        return { kind: 'read-unavailable', message: cloudResult.message };
    }
    if (
        cloudResult.kind === 'loaded'
        || cloudResult.data.workLogDeletionTombstones.length > 0
    ) {
        const excludedSyncIds = new Set(options.excludedWorkLogSyncIds ?? []);
        const cloudWorkLogs = excludedSyncIds.size === 0
            ? cloudResult.data.workLogs
            : cloudResult.data.workLogs.filter(
                (workLog) => !workLog.syncId || !excludedSyncIds.has(workLog.syncId),
            );
        await performMergeCloudToLocal(
            cloudWorkLogs,
            cloudResult.data.projects,
            cloudResult.data.workLogDeletionTombstones ?? [],
        );
    }
    const [storedTombstones, storedWorkLogs, allProjects] = await db.transaction(
        'r',
        [db.workLogDeletionTombstones, db.workLogs, db.projects],
        () => Promise.all([
            db.workLogDeletionTombstones.toArray(),
            db.workLogs.toArray(),
            db.projects.toArray(),
        ]),
    );
    const tombstones = mergeWorkLogDeletionTombstones(storedTombstones);
    const tombstonedIds = new Set(tombstones.map((tombstone) => tombstone.syncId));
    const allWorkLogs = storedWorkLogs.filter(
        (workLog) => !workLog.syncId || !tombstonedIds.has(workLog.syncId),
    );
    return workLogsSync.saveAllDetailed({
        workLogs: allWorkLogs,
        projects: allProjects,
        workLogDeletionTombstones: tombstones,
    });
}

export async function mergeLocalToCloudDetailed(
    options: MergeLocalToCloudOptions = {},
): Promise<WorkLogsPublishResult> {
    return enqueueWorkLogsSync(async () => {
        try {
            return await performMergeLocalToCloudDetailed(options);
        } catch (error) {
            return { kind: 'unexpected-error', message: getErrorMessage(error) };
        }
    });
}

export async function mergeLocalToCloud(
    options: MergeLocalToCloudOptions = {},
): Promise<boolean> {
    return (await mergeLocalToCloudDetailed(options)).kind === 'published';
}
