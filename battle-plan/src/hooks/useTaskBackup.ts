import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { taskDriveBackup } from '../services/taskDriveBackup';
import { hasUsableAuth, type GoogleAuthStatus } from '../types';
import { getErrorMessage } from '../utils/errors';
import { readTaskBackupSnapshot } from '../utils/taskBackupRevision.ts';
import type { SyncHealth } from './useSyncDiagnostics';
import { createTaskBackupCoordinator } from './taskBackupCoordinator.ts';

interface UseTaskBackupArgs {
    googleAuth: GoogleAuthStatus;
    ready: boolean;
    setLastSync: (value: string | null) => void;
    addLog: (message: string, type?: 'info' | 'error') => void;
    updateSyncHealth: (key: string, patch: Partial<SyncHealth>) => void;
}

export function useTaskBackup({ googleAuth, ready, setLastSync, addLog, updateSyncHealth }: UseTaskBackupArgs) {
    const enabled = hasUsableAuth(googleAuth) && ready;
    const snapshot = useLiveQuery(readTaskBackupSnapshot, []);
    const coordinator = useRef<ReturnType<typeof createTaskBackupCoordinator> | null>(null);

    useEffect(() => {
        const instance = createTaskBackupCoordinator({
            save: (data) => taskDriveBackup.save(data),
            onSaved: (timestamp) => {
                const now = new Date().toLocaleString('cs-CZ');
                setLastSync(now);
                localStorage.setItem('last_drive_sync', now);
                localStorage.setItem('last_drive_sync_ts', timestamp.toString());
                updateSyncHealth('tasks', {
                    state: 'ok', detail: 'Automatická záloha na Disk úspěšná', lastSuccess: now, lastError: null,
                });
                addLog('Automatická záloha na Disk úspěšná');
            },
            onError: (error) => {
                console.error('Auto-backup failed', error);
                updateSyncHealth('tasks', {
                    state: 'error', detail: 'Automatická záloha na Disk selhala', lastError: getErrorMessage(error),
                });
            },
        });
        coordinator.current = instance;
        return () => { instance.stop(); coordinator.current = null; };
    }, [googleAuth.accessToken, setLastSync, addLog, updateSyncHealth]);

    useEffect(() => {
        coordinator.current?.update(snapshot, enabled);
    }, [snapshot, enabled, googleAuth.accessToken, setLastSync, addLog, updateSyncHealth]);
}
