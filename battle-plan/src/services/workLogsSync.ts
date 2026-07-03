import { db, type WorkLog, type Project } from '../db';
import { WORKLOGS_FILENAME } from './workLogsDriveMetadata';
import { getWorkLogSyncKey } from '../utils/workLogSyncIdentity';
import { DriveJsonStore } from './driveJsonStore';

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

class WorkLogsSync {
    private fileId: string | null = null;
    private isInitialized = false;
    private readonly drive = new DriveJsonStore();

    async init(): Promise<void> {
        if (this.isInitialized) return;
        this.isInitialized = await this.drive.init();
    }

    /**
     * Načte work_logs_data.json z Drive. Pokud neexistuje, vrátí prázdné pole.
     */
    async loadAll(): Promise<{ workLogs: WorkLog[]; projects: Project[]; timestamp: number }> {
        if (!this.isInitialized) {
            return { workLogs: [], projects: [], timestamp: 0 };
        }

        try {
            const loaded = await this.drive.readJsonFile<WorkLogsFile>(WORKLOGS_FILENAME);
            if (!loaded) return { workLogs: [], projects: [], timestamp: 0 };
            this.fileId = loaded.fileId;
            const data = loaded.data;
            return {
                workLogs: data.workLogs ?? [],
                projects: data.projects ?? [],
                timestamp: data.last_updated ?? 0,
            };
        } catch (e) {
            console.error('WorkLogsSync: loadAll failed', e);
            return { workLogs: [], projects: [], timestamp: 0 };
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
 *    - pokud není v local → add (a remapuj projectId v budoucnu — pro F6 necháme jak je)
 *    - pokud je v local a cloud.updatedAt > local.updatedAt → put
 * 3. Pro local WorkLogy/Projects, které nejsou v cloudu → ponecháme (merge je add/update only,
 *    delete nechá na userovi)
 *
 * DŮLEŽITÉ: při ukládání do cloudu se změny v projectId mohou rozjet (cloud Project může mít jiné ID).
 * Pro F6 to řešíme tak, že projectName je v WorkLogu denormalizovaný — UI zobrazuje projectName.
 * Později (F7+) můžeme dělat remap.
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

    const localWorkLogs = await db.workLogs.toArray();
    const localProjects = await db.projects.toArray();

    const localWorkLogsByCompositeKey = new Map<string, WorkLog>();
    for (const wl of localWorkLogs) {
        const key = getWorkLogSyncKey(wl);
        localWorkLogsByCompositeKey.set(key, wl);
    }

    const localProjectsByName = new Map<string, Project>();
    for (const p of localProjects) {
        localProjectsByName.set(p.name.toLowerCase(), p);
    }

    await db.transaction('rw', [db.workLogs, db.projects], async () => {
        // === WorkLogs ===
        for (const cw of cloudWorkLogs) {
            const key = getWorkLogSyncKey(cw);
            const local = localWorkLogsByCompositeKey.get(key);
            if (!local) {
                // Cloud-only → přidej (s novým ID)
                const withoutId = { ...cw };
                delete withoutId.id;
                await db.workLogs.add({
                    ...withoutId,
                    source: withoutId.source ?? 'voice',
                    createdAt: withoutId.createdAt ?? Date.now(),
                    updatedAt: withoutId.updatedAt ?? Date.now(),
                });
                result.workLogsAdded++;
            } else if ((cw.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
                // Cloud novější → update (zachováme local id)
                await db.workLogs.update(local.id!, {
                    ...cw,
                    id: local.id, // nepřepisujeme ID
                    createdAt: local.createdAt, // createdAt je posvátné
                    updatedAt: cw.updatedAt ?? Date.now(),
                });
                result.workLogsUpdated++;
            }
        }

        // === Projects ===
        for (const cp of cloudProjects) {
            const local = localProjectsByName.get(cp.name.toLowerCase());
            if (!local) {
                const withoutId = { ...cp };
                delete withoutId.id;
                await db.projects.add({
                    ...withoutId,
                    isActive: withoutId.isActive ?? true,
                    createdAt: withoutId.createdAt ?? Date.now(),
                    updatedAt: withoutId.updatedAt ?? Date.now(),
                });
                result.projectsAdded++;
            } else if ((cp.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
                await db.projects.update(local.id!, {
                    name: cp.name,
                    color: cp.color,
                    isActive: cp.isActive,
                    updatedAt: cp.updatedAt ?? Date.now(),
                    // createdAt zachovej
                });
                result.projectsUpdated++;
            }
        }
    });

    return result;
}

/**
 * Odešle kompletní payload z IndexedDB do cloudu. Jednoduchý "celé to tam hoď" přístup.
 * Později (F7+) můžeme dělat deltas, ale pro F6 stačí celý payload.
 */
export async function mergeLocalToCloud(): Promise<boolean> {
    if (!workLogsSync.initialized) {
        await workLogsSync.init();
        if (!workLogsSync.initialized) return false;
    }
    const cloud = await workLogsSync.loadAll();
    if (cloud.timestamp > 0) {
        await mergeCloudToLocal(cloud.workLogs, cloud.projects);
    }
    const allWorkLogs = await db.workLogs.toArray();
    const allProjects = await db.projects.toArray();
    const ts = await workLogsSync.saveAll({ workLogs: allWorkLogs, projects: allProjects });
    return ts !== null;
}
