import type { Setting, Task } from '../db';
import { DriveJsonStore, type DriveStoreStatus, type DriveJsonReadManyResult } from './driveJsonStore.ts';
import { filterTaskBackupSettings } from '../utils/taskBackupSettings.ts';
import { mergeTaskBackupSnapshots } from './taskBackupSnapshots.ts';
import { canonicalBackupJson } from '../utils/canonicalBackupJson.ts';
import { googleService } from './googleService.ts';

const TASK_BACKUP_FILENAME = 'battle_plan_data.json';
const TASK_SNAPSHOT_FILENAME = 'battle_plan_task_snapshot_v2.json';

export interface TaskDriveBackupData {
    tasks?: Task[];
    settings?: Setting[];
}

export interface TaskDriveBackupPayload {
    version?: string;
    timestamp?: number;
    data?: TaskDriveBackupData;
}

export type TaskDriveBackupLoadResult =
    | { kind: 'loaded'; payload: TaskDriveBackupPayload }
    | { kind: 'missing-file' }
    | { kind: 'store-unavailable'; status: DriveStoreStatus }
    | { kind: 'error'; message: string };

type TaskBackupStore = Pick<DriveJsonStore, 'init' | 'initWithStatus' | 'writeJsonFile' | 'readJsonFilesWithStatus' | 'readJsonFileByIdWithStatus'> & { readonly currentFolderId?: string | null };
type SnapshotReadResult = DriveJsonReadManyResult<TaskDriveBackupPayload> & { immutableIds?: Set<string> };

export class TaskDriveBackup {
    private readonly drive: TaskBackupStore;
    private lastPublication?: { key: string; scope: string; fileId: string; payload: TaskDriveBackupPayload };

    constructor(drive: TaskBackupStore = new DriveJsonStore()) { this.drive = drive; }

    async save(data: TaskDriveBackupData): Promise<number | null> {
        const initialized = await this.drive.init({ createFolder: true });
        if (!initialized) return null;

        const portableData = { tasks: structuredClone(data.tasks ?? []), settings: filterTaskBackupSettings(data.settings) };
        const key = canonicalBackupJson(portableData);
        const scope = canonicalBackupJson([googleService.getAccountId(), this.drive.currentFolderId]);
        let publication = this.lastPublication?.key === key && this.lastPublication.scope === scope
            ? this.lastPublication : undefined;
        this.lastPublication = publication;
        let payload: TaskDriveBackupPayload = publication?.payload ?? {
            version: '2.0',
            timestamp: Date.now(),
            data: portableData,
        };

        try {
            const before = await this.readSnapshots();
            if (before.kind === 'error') throw new Error(before.message);
            if (before.kind === 'store-unavailable') throw new Error(before.status.message);
            const files = before.kind === 'loaded' ? before.files : [];
            // Recover a visible previous upload after a reload or lost response.
            // An older match may be an intentional return to a prior preference.
            const latestTimestamp = files.reduce((latest, file) => Math.max(latest, file.data.timestamp ?? 0), 0);
            const matching = files.find(file => before.immutableIds?.has(file.fileId)
                && file.data.timestamp === latestTimestamp
                && canonicalBackupJson(file.data.data) === key);
            if (!publication && matching) {
                payload = matching.data;
                publication = { key, scope, fileId: matching.fileId, payload };
            }
            // Reject known conflicts before adding another permanent file.
            mergeTaskBackupSnapshots([...files.map(file => file.data), payload]);
            if (!publication) {
                const saved = await this.drive.writeJsonFile(TASK_SNAPSHOT_FILENAME, payload, null, { createOnly: true });
                if (!saved?.fileId) throw new Error('Drive nepotvrdil identitu uložené zálohy úkolů.');
                publication = { key, scope, fileId: saved.fileId, payload };
            }
            this.lastPublication = publication;
            const publishedFileId = publication.fileId;
            const persisted = await this.drive.readJsonFileByIdWithStatus<TaskDriveBackupPayload>(publishedFileId);
            if (persisted.kind !== 'loaded' || canonicalBackupJson(persisted.data) !== canonicalBackupJson(payload)) {
                throw new Error('Uloženou zálohu úkolů se nepodařilo ověřit.');
            }
            const aggregate = await this.readSnapshots();
            if (aggregate.kind !== 'loaded' || !aggregate.files.some(file => file.fileId === publishedFileId
                && canonicalBackupJson(file.data) === canonicalBackupJson(payload))) {
                throw new Error('Publikovaná záloha úkolů není viditelná ve společném seznamu.');
            }
            // Its presence proves the union contains every intended row or a
            // newer compatible version; the reducer rejects ambiguous versions.
            mergeTaskBackupSnapshots(aggregate.files.map(file => file.data));
            this.lastPublication = undefined;
            return payload.timestamp ?? null;
        } catch (e) {
            console.error('TaskDriveBackup: save failed', e);
            throw e;
        }
    }

    async load(): Promise<TaskDriveBackupPayload | null> {
        const result = await this.loadDetailed();
        return result.kind === 'loaded' ? result.payload : null;
    }

    async loadDetailed(): Promise<TaskDriveBackupLoadResult> {
        const status = await this.drive.initWithStatus({ createFolder: true });
        if (status.code !== 'ready' && status.code !== 'folder-created') {
            return { kind: 'store-unavailable', status };
        }

        try {
            const result = await this.readSnapshots();
            if (result.kind !== 'loaded') return result;
            return { kind: 'loaded', payload: mergeTaskBackupSnapshots(result.files.map(file => file.data)) };
        } catch (e) {
            console.error('TaskDriveBackup: load failed', e);
            return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        }
    }

    private async readSnapshots(): Promise<SnapshotReadResult> {
        const results = await Promise.all([TASK_BACKUP_FILENAME, TASK_SNAPSHOT_FILENAME].map(name =>
            this.drive.readJsonFilesWithStatus<TaskDriveBackupPayload>(name, { cacheUnchanged: true })));
        for (const result of results) {
            if (result.kind === 'error' || result.kind === 'store-unavailable') return result;
        }
        const files = results.flatMap(result => result.kind === 'loaded' ? result.files : []);
        const immutable = results[1];
        const immutableIds = new Set(immutable.kind === 'loaded' ? immutable.files.map(file => file.fileId) : []);
        return files.length ? { kind: 'loaded', files, immutableIds } : { kind: 'missing-file' };
    }
}

export const taskDriveBackup = new TaskDriveBackup();
