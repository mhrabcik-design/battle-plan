import type { DriveStoreStatus } from '../services/driveJsonStore';
import type { TaskDriveBackupLoadResult } from '../services/taskDriveBackup';
import type { SyncHealth } from '../hooks/useSyncDiagnostics';
import { ProjectIdentityConflictError } from './projectIdentityReconciliation.ts';
import { getErrorMessage } from './errors.ts';
import { DriveTransportError } from '../services/agentProtocol/driveTransport.ts';

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

export function agentDriveTransportHealth(error: unknown): Partial<SyncHealth> {
    if (!(error instanceof DriveTransportError)) {
        const message = getErrorMessage(error);
        return { state: 'error', detail: 'Agent protocol Drive transport selhal', lastError: message };
    }
    if (error.code === 'authorization_failed') {
        return { state: 'idle', detail: 'Agent protocol čeká na Drive autorizaci', lastError: error.message };
    }
    if (error.code === 'rate_limited' || error.code === 'transport_retryable') {
        return { state: 'stale', detail: 'Agent protocol Drive transport bude zopakován', lastError: error.message };
    }
    if (error.code === 'workspace_missing'
        || error.code === 'workspace_ambiguous'
        || error.code === 'workspace_parent_mismatch'
        || error.code === 'workspace_authority_mismatch'
        || error.code === 'stale_binding_cache') {
        return { state: 'error', detail: 'Agent protocol Drive pairing není bezpečně ověřen', lastError: error.message };
    }
    return { state: 'error', detail: `Agent protocol Drive: ${error.code}`, lastError: error.message };
}

export function autoSyncFailureHealth(error: unknown): {
    key: 'tasks' | 'worklogs';
    patch: Partial<SyncHealth>;
} {
    const message = getErrorMessage(error);
    if (error instanceof ProjectIdentityConflictError) {
        return {
            key: 'worklogs',
            patch: {
                state: 'error',
                detail: 'Synchronizace WorkLogs narazila na konflikt identity projektů',
                lastError: message,
            },
        };
    }
    return {
        key: 'tasks',
        patch: {
            state: 'error',
            detail: 'Automatická synchronizace selhala',
            lastError: message,
        },
    };
}
