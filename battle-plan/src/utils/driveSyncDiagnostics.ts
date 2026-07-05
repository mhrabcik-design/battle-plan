import type { DriveStoreStatus } from '../services/driveJsonStore';
import type { TaskDriveBackupLoadResult } from '../services/taskDriveBackup';
import type { SyncHealth } from '../hooks/useSyncDiagnostics';

export function driveUnavailableHealth(status: DriveStoreStatus): Partial<SyncHealth> {
    return {
        state: status.code === 'auth-unavailable' ? 'idle' : 'error',
        detail: status.message,
        lastError: status.code === 'auth-unavailable' ? null : status.message,
    };
}

export function taskBackupHealth(result: Exclude<TaskDriveBackupLoadResult, { kind: 'loaded' }>): Partial<SyncHealth> {
    if (result.kind === 'store-unavailable') return driveUnavailableHealth(result.status);
    if (result.kind === 'error') {
        return {
            state: 'error',
            detail: 'Načtení Drive zálohy selhalo',
            lastError: result.message,
        };
    }
    return {
        state: 'idle',
        detail: 'Drive záloha úkolů zatím neexistuje',
        lastError: null,
    };
}

export function emptySuggestionsHealth(): Partial<SyncHealth> {
    return {
        state: 'ok',
        detail: 'Žádné návrhy na Drive zatím nejsou',
        lastError: null,
    };
}
