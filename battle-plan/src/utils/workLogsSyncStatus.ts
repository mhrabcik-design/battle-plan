import type { SyncState } from '../hooks/useSyncDiagnostics';

interface WorkLogsLocalCounts {
    workLogs: number;
    projects: number;
}

interface MissingWorkLogsFileStatus {
    state: SyncState;
    detail: string;
}

export function hasLocalWorkLogsData(counts: WorkLogsLocalCounts): boolean {
    return counts.workLogs > 0 || counts.projects > 0;
}

export function getMissingWorkLogsFileStatus(counts: WorkLogsLocalCounts): MissingWorkLogsFileStatus {
    if (!hasLocalWorkLogsData(counts)) {
        return {
            state: 'idle',
            detail: 'Čeká na první pracovní záznam',
        };
    }

    return {
        state: 'stale',
        detail: 'WorkLogs soubor zatím neexistuje, vytvářím zálohu',
    };
}
