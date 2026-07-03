import type { Setting, Task } from '../db';
import { DriveJsonStore } from './driveJsonStore';

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
        const initialized = await this.drive.init({ createFolder: true });
        if (!initialized) return null;

        try {
            const loaded = await this.drive.readJsonFile<TaskDriveBackupPayload>(TASK_BACKUP_FILENAME);
            return loaded?.data ?? null;
        } catch (e) {
            console.error('TaskDriveBackup: load failed', e);
            return null;
        }
    }
}

export const taskDriveBackup = new TaskDriveBackup();

