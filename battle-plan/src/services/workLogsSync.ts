import { db, type WorkLog, type Project } from '../db';
import { WORKLOGS_FILENAME } from './workLogsDriveMetadata';
import { getWorkLogSyncKey } from '../utils/workLogSyncIdentity';
import { DriveJsonStore, type DriveStoreStatus } from './driveJsonStore';
import { normalizeProjectName } from './projectCatalog';
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
}

export interface WorkLogsLoadData {
    workLogs: WorkLog[];
    projects: Project[];
    timestamp: number;
}

export type WorkLogsLoadResult =
    | { kind: 'loaded'; data: WorkLogsLoadData }
    | { kind: 'missing-file'; data: WorkLogsLoadData }
    | { kind: 'store-unavailable'; status: DriveStoreStatus; data: WorkLogsLoadData }
    | { kind: 'error'; message: string; data: WorkLogsLoadData };

const emptyWorkLogsLoadData = (): WorkLogsLoadData => ({ workLogs: [], projects: [], timestamp: 0 });

class WorkLogsSync {
    private fileId: string | null = null;
    private isInitialized = false;
    private readonly drive = new DriveJsonStore();

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
            const result = await this.drive.readJsonFileWithStatus<WorkLogsFile>(WORKLOGS_FILENAME);
            if (result.kind === 'missing-file') return { kind: 'missing-file', data: emptyWorkLogsLoadData() };
            if (result.kind === 'store-unavailable') return { ...result, data: emptyWorkLogsLoadData() };
            if (result.kind === 'error') return { ...result, data: emptyWorkLogsLoadData() };
            this.fileId = result.fileId;
            const data = result.data;
            return {
                kind: 'loaded',
                data: {
                    workLogs: data.workLogs ?? [],
                    projects: data.projects ?? [],
                    timestamp: data.last_updated ?? 0,
                },
            };
        } catch (e) {
            console.error('WorkLogsSync: loadAll failed', e);
            return { kind: 'error', message: e instanceof Error ? e.message : String(e), data: emptyWorkLogsLoadData() };
        }
    }

    /**
     * Zapíše kompletní payload (workLogs + projects) do work_logs_data.json.
     * Pokud soubor neexistuje, vytvoří ho.
     */
    async saveAll(payload: { workLogs: WorkLog[]; projects: Project[] }): Promise<number | null> {
        if (!this.isInitialized) {
            return null;
        }

        const timestamp = Date.now();
        const fileContent = {
            version: 1,
            last_updated: timestamp,
            workLogs: payload.workLogs,
            projects: payload.projects,
        };

        try {
            const saved = await this.drive.writeJsonFile(WORKLOGS_FILENAME, fileContent, this.fileId);
            if (!saved) return null;
            if (saved.fileId) {
                this.fileId = saved.fileId;
            }
            return timestamp;
        } catch (e) {
            console.error('WorkLogsSync: saveAll failed', e);
            return null;
        }
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
export async function mergeCloudToLocal(
    cloudWorkLogs: WorkLog[],
    cloudProjects: Project[]
): Promise<MergeResult> {
    const result: MergeResult = {
        workLogsAdded: 0,
        workLogsUpdated: 0,
        projectsAdded: 0,
        projectsUpdated: 0,
        workLogsRemoved: 0,
        projectsRemoved: 0,
    };

    await db.transaction('rw', [db.workLogs, db.projects], async () => {
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
interface MergeLocalToCloudOptions {
    excludedWorkLogSyncIds?: readonly string[];
}

export async function mergeLocalToCloud(
    options: MergeLocalToCloudOptions = {},
): Promise<boolean> {
    if (!workLogsSync.initialized) {
        await workLogsSync.init();
        if (!workLogsSync.initialized) return false;
    }
    const cloudResult = await workLogsSync.loadAllDetailed();
    if (cloudResult.kind === 'store-unavailable' || cloudResult.kind === 'error') {
        return false;
    }
    if (cloudResult.kind === 'loaded' && cloudResult.data.timestamp > 0) {
        const excludedSyncIds = new Set(options.excludedWorkLogSyncIds ?? []);
        const cloudWorkLogs = excludedSyncIds.size === 0
            ? cloudResult.data.workLogs
            : cloudResult.data.workLogs.filter(
                (workLog) => !workLog.syncId || !excludedSyncIds.has(workLog.syncId),
            );
        await mergeCloudToLocal(cloudWorkLogs, cloudResult.data.projects);
    }
    const allWorkLogs = await db.workLogs.toArray();
    const allProjects = await db.projects.toArray();
    const ts = await workLogsSync.saveAll({ workLogs: allWorkLogs, projects: allProjects });
    return ts !== null;
}
