/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    autoSyncFailureHealth,
    agentDriveTransportHealth,
    driveUnavailableHealth,
    emptySuggestionsHealth,
    GOOGLE_DRIVE_RECONSENT_MESSAGE,
    isDriveScopeError,
    taskBackupHealth,
    workLogsBackupHealth,
} from './driveSyncDiagnostics.ts';
import { ProjectIdentityConflictError } from './projectIdentityReconciliation.ts';
import { DriveTransportError } from '../services/agentProtocol/driveTransport.ts';

test('Drive scope diagnostics centralize permission detection and recovery guidance', () => {
    assert.equal(isDriveScopeError('403 Forbidden'), true);
    assert.equal(isDriveScopeError(new Error('PERMISSION_DENIED')), true);
    assert.equal(isDriveScopeError('Insufficient Authentication Scopes'), true);
    assert.equal(isDriveScopeError('500 Internal Server Error'), false);
    assert.match(GOOGLE_DRIVE_RECONSENT_MESSAGE, /myaccount\.google\.com\/permissions/);
});

test('project identity conflicts are routed to WorkLogs sync health', () => {
    const conflict = new ProjectIdentityConflictError('alias collision', ['plaza']);

    assert.deepEqual(autoSyncFailureHealth(conflict), {
        key: 'worklogs',
        patch: {
            state: 'error',
            detail: 'Synchronizace WorkLogs narazila na konflikt identity projektů',
            lastError: 'alias collision',
        },
    });
});

test('driveUnavailableHealth keeps auth-unavailable idle and Drive failures actionable', () => {
    assert.deepEqual(
        driveUnavailableHealth({ code: 'auth-unavailable', message: 'Pro přístup na Drive je nutné přihlášení.' }),
        {
            state: 'idle',
            detail: 'Pro přístup na Drive je nutné přihlášení.',
            lastError: null,
        },
    );

    assert.deepEqual(
        driveUnavailableHealth({ code: 'drive-client-unavailable', message: 'Google Drive klient není dostupný' }),
        {
            state: 'error',
            detail: 'Google Drive klient není dostupný',
            lastError: 'Google Drive klient není dostupný',
        },
    );
});

test('taskBackupHealth treats missing first-run backup as idle instead of stale', () => {
    assert.deepEqual(taskBackupHealth({ kind: 'missing-file' }), {
        state: 'idle',
        detail: 'Drive záloha úkolů zatím neexistuje',
        lastError: null,
    });
});

test('taskBackupHealth preserves real read errors', () => {
    assert.deepEqual(taskBackupHealth({ kind: 'error', message: '500 Nope' }), {
        state: 'error',
        detail: 'Načtení Drive zálohy selhalo',
        lastError: '500 Nope',
    });
});

test('workLogsBackupHealth never presents a rejected publication as stale', () => {
    const failures = [
        { kind: 'store-unavailable' as const, status: { code: 'drive-client-unavailable' as const, message: 'Drive client missing' }, message: 'Drive client missing' },
        { kind: 'read-unavailable' as const, message: 'Drive read failed' },
        { kind: 'verification-failed' as const, message: 'Snapshot verification failed' },
        { kind: 'unexpected-error' as const, message: 'Unexpected write failure' },
    ];

    assert.deepEqual(
        failures.map(workLogsBackupHealth),
        [
            { state: 'error', detail: 'WorkLogs záloha na Disk selhala', lastError: 'Drive client missing' },
            { state: 'error', detail: 'WorkLogs záloha na Disk selhala', lastError: 'Drive read failed' },
            { state: 'error', detail: 'WorkLogs zálohu se nepodařilo ověřit', lastError: 'Snapshot verification failed' },
            { state: 'error', detail: 'WorkLogs záloha na Disk selhala', lastError: 'Unexpected write failure' },
        ],
    );
});

test('emptySuggestionsHealth reports a healthy empty suggestions file state', () => {
    assert.deepEqual(emptySuggestionsHealth(), {
        state: 'ok',
        detail: 'Žádné návrhy na Drive zatím nejsou',
        lastError: null,
    });
});

test('agent protocol Drive diagnostics keep authorization, retry, and pairing ambiguity distinct', () => {
    assert.deepEqual(
        agentDriveTransportHealth(new DriveTransportError('authorization_failed', '401')),
        { state: 'idle', detail: 'Agent protocol čeká na Drive autorizaci', lastError: '401' },
    );
    assert.deepEqual(
        agentDriveTransportHealth(new DriveTransportError('rate_limited', '429')),
        { state: 'stale', detail: 'Agent protocol Drive transport bude zopakován', lastError: '429' },
    );
    assert.deepEqual(
        agentDriveTransportHealth(new DriveTransportError('workspace_ambiguous', 'two folders')),
        { state: 'error', detail: 'Agent protocol Drive pairing není bezpečně ověřen', lastError: 'two folders' },
    );
});
