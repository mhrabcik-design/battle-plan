import type { DriveStoreStatus } from '../services/driveJsonStore';
import type { TaskDriveBackupLoadResult } from '../services/taskDriveBackup';
import type { SyncHealth } from '../hooks/useSyncDiagnostics';
import { getErrorMessage } from './errors.ts';

const DRIVE_SCOPE_ERROR_PATTERN = /403|PERMISSION_DENIED|Insufficient Authentication Scopes/i;

export const GOOGLE_DRIVE_RECONSENT_MESSAGE =
    "Drive odmítl požadavek: scope tvořiho Google účtu neobsahuje aktuální scopes aplikace. Jdi na https://myaccount.google.com/permissions, odeber 'Battle Plan', a přihlaš se znovu.";

export function isDriveScopeError(error: unknown): boolean {
    return DRIVE_SCOPE_ERROR_PATTERN.test(getErrorMessage(error));
}

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
