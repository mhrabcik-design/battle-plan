import type { Setting, Task } from '../db';
import { DriveJsonStore, type DriveStoreStatus } from './driveJsonStore';

const TASK_BACKUP_FILENAME = 'battle_plan_data.json';

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

class TaskDriveBackup {
    private readonly drive = new DriveJsonStore();

    async save(data: TaskDriveBackupData): Promise<number | null> {
        const initialized = await this.drive.init({ createFolder: true });
        if (!initialized) return null;

        const payload: TaskDriveBackupPayload = {
            version: '1.2',
            timestamp: Date.now(),
            data,
        };

        try {
            const saved = await this.drive.writeJsonFile(TASK_BACKUP_FILENAME, payload);
            return saved ? payload.timestamp ?? null : null;
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
            const result = await this.drive.readJsonFileWithStatus<TaskDriveBackupPayload>(TASK_BACKUP_FILENAME);
            if (result.kind === 'loaded') return { kind: 'loaded', payload: result.data };
            if (result.kind === 'missing-file') return { kind: 'missing-file' };
            return result;
        } catch (e) {
            console.error('TaskDriveBackup: load failed', e);
            return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        }
    }
}

export const taskDriveBackup = new TaskDriveBackup();
