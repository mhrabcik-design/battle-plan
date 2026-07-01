export const WORKLOGS_FILENAME = 'work_logs_data.json';

export interface WorkLogsFileMetadata {
    name: string;
    mimeType: 'application/json';
    parents?: string[];
}

export function buildWorkLogsFileMetadata(folderId: string, fileId: string | null): WorkLogsFileMetadata {
    const metadata: WorkLogsFileMetadata = { name: WORKLOGS_FILENAME, mimeType: 'application/json' };
    if (!fileId) {
        metadata.parents = [folderId];
    }
    return metadata;
}
