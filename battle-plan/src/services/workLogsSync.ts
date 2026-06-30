import { db, type WorkLog, type Project } from '../db';

/**
 * WorkLogsSync — Drive I/O pro `work_logs_data.json` ve složce `/Anu-BattlePlan/`.
 *
 * Pattern kopíruje `suggestionsSync.ts`:
 * - init() najde složku (cache v localStorage)
 * - loadAll() / saveAll() přes raw fetch s Bearer tokenem
 * - multipart PATCH upload pro update existujícího souboru
 * - vše best-effort, chyby jen loguje (nevyhazují výjimky)
 *
 * F6 = merge logika: `mergeCloudToLocal()` porovná cloud vs IndexedDB
 * (updatedAt winner-wins), `mergeLocalToCloud()` odešle kompletní payload.
 */

const FOLDER_NAME = 'Anu-BattlePlan';
const WORKLOGS_FILENAME = 'work_logs_data.json';
const FOLDER_CACHE_KEY = 'bp_folder_id';

interface WorkLogsFile {
    version?: number;
    last_updated?: number;
    workLogs: WorkLog[];
    projects: Project[];
}

class WorkLogsSync {
    private folderId: string | null = null;
    private fileId: string | null = null;
    private accessToken: string | null = null;
    private isInitialized = false;

    async init(): Promise<void> {
        if (this.isInitialized) return;
        if (!window.gapi?.client?.drive) {
            console.warn('WorkLogsSync: GAPI not available');
            return;
        }
        this.accessToken = localStorage.getItem('google_access_token');
        if (!this.accessToken) {
            console.warn('WorkLogsSync: Not signed in');
            return;
        }

        const cached = localStorage.getItem(FOLDER_CACHE_KEY);
        if (cached) {
            this.folderId = cached;
        } else {
            try {
                const r = await window.gapi.client.drive.files.list({
                    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                    spaces: 'drive',
                    fields: 'files(id)',
                    pageSize: 1,
                });
                if (r.result.files?.[0]) {
                    this.folderId = r.result.files[0].id;
                    localStorage.setItem(FOLDER_CACHE_KEY, this.folderId);
                } else {
                    console.warn(`WorkLogsSync: Folder /${FOLDER_NAME}/ not found`);
                    return;
                }
            } catch (e) {
                console.error('WorkLogsSync: Failed to find folder', e);
                return;
            }
        }
        this.isInitialized = true;
    }

    /**
     * Načte work_logs_data.json z Drive. Pokud neexistuje, vrátí prázdné pole.
     */
    async loadAll(): Promise<{ workLogs: WorkLog[]; projects: Project[]; timestamp: number }> {
        if (!this.isInitialized || !this.folderId || !this.accessToken) {
            return { workLogs: [], projects: [], timestamp: 0 };
        }

        try {
            const listR = await window.gapi.client.drive.files.list({
                q: `name='${WORKLOGS_FILENAME}' and '${this.folderId}' in parents and trashed=false`,
                spaces: 'drive',
                fields: 'files(id)',
                pageSize: 1,
            });
            const fileMeta = listR.result.files?.[0];
            if (!fileMeta) return { workLogs: [], projects: [], timestamp: 0 };
            this.fileId = fileMeta.id;

            const resp = await fetch(
                `https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`,
                { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
            );
            if (!resp.ok) return { workLogs: [], projects: [], timestamp: 0 };

            const data = (await resp.json()) as WorkLogsFile;
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
        if (!this.isInitialized || !this.folderId || !this.accessToken) {
            return null;
        }

        const fileContent = JSON.stringify({
            version: 1,
            last_updated: Date.now(),
            workLogs: payload.workLogs,
            projects: payload.projects,
        });

        const boundary = '-------314159265358979323846';
        const metadata = { name: WORKLOGS_FILENAME, mimeType: 'application/json' };
        const body =
            '--' + boundary + '\r\n' +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            JSON.stringify(metadata) + '\r\n' +
            '--' + boundary + '\r\n' +
            'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
            fileContent + '\r\n' +
            '--' + boundary + '--';

        try {
            if (this.fileId) {
                // Update existujícího souboru
                await window.gapi.client.request({
                    path: `/upload/drive/v3/files/${this.fileId}?uploadType=multipart`,
                    method: 'PATCH',
                    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                    body: body,
                });
            } else {
                // Vytvoření nového souboru (fileId si uložíme později při loadAll)
                await window.gapi.client.request({
                    path: `/upload/drive/v3/files?uploadType=multipart`,
                    method: 'POST',
                    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                    body: body,
                });
            }
            return Date.now();
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
        // Composite key = date + projectName + people (bez hours, protože hours se může měnit při editaci)
        // POZOR: lepší by bylo mít clientId UUID v záznamech — TODO F7+
        const key = `${wl.date}|${wl.projectName}|${wl.people}`;
        localWorkLogsByCompositeKey.set(key, wl);
    }

    const localProjectsByName = new Map<string, Project>();
    for (const p of localProjects) {
        localProjectsByName.set(p.name.toLowerCase(), p);
    }

    await db.transaction('rw', [db.workLogs, db.projects], async () => {
        // === WorkLogs ===
        for (const cw of cloudWorkLogs) {
            const key = `${cw.date}|${cw.projectName}|${cw.people}`;
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
    const allWorkLogs = await db.workLogs.toArray();
    const allProjects = await db.projects.toArray();
    const ts = await workLogsSync.saveAll({ workLogs: allWorkLogs, projects: allProjects });
    return ts !== null;
}
