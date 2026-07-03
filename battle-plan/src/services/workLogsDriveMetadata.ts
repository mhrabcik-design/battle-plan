import { buildDriveFileMetadata } from './driveJsonStore.ts';

export const WORKLOGS_FILENAME = 'work_logs_data.json';

export interface WorkLogsFileMetadata {
    name: string;
    mimeType: 'application/json';
    parents?: string[];
}

export function buildWorkLogsFileMetadata(folderId: string, fileId: string | null): WorkLogsFileMetadata {
    return buildDriveFileMetadata(WORKLOGS_FILENAME, 'application/json', folderId, fileId) as WorkLogsFileMetadata;
}
