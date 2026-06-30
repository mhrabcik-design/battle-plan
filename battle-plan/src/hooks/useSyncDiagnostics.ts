import { useCallback, useState } from 'react';

export type SyncState = 'idle' | 'ok' | 'stale' | 'error';

export interface SyncHealth {
    label: string;
    state: SyncState;
    detail: string;
    lastSuccess: string | null;
    lastError: string | null;
}

export const createSyncHealth = (label: string, detail = 'Čeká na první kontrolu'): SyncHealth => ({
    label,
    state: 'idle',
    detail,
    lastSuccess: null,
    lastError: null,
});

export function useSyncDiagnostics() {
    const [syncHealth, setSyncHealth] = useState<Record<string, SyncHealth>>({
        google: createSyncHealth('Google Auth', 'Inicializace Google služeb'),
        tasks: createSyncHealth('Tasks Drive Sync', 'Čeká na přihlášení'),
        worklogs: createSyncHealth('WorkLogs Sync', 'Čeká na přihlášení'),
        suggestions: createSyncHealth('Suggestions Sync', 'Čeká na přihlášení'),
    });

    const updateSyncHealth = useCallback((key: string, patch: Partial<SyncHealth>) => {
        setSyncHealth(prev => ({
            ...prev,
            [key]: {
                ...(prev[key] ?? createSyncHealth(key)),
                ...patch,
            },
        }));
    }, []);

    return { syncHealth, updateSyncHealth };
}
