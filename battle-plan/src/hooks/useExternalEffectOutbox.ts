import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { googleService } from '../services/googleService';
import { createExternalEffectScheduler, drainGoogleExternalEffects, summarizeExternalEffects } from '../services/externalEffectOutbox.ts';
import { hasUsableAuth, type GoogleAuthStatus } from '../types';
import type { SyncHealth } from './useSyncDiagnostics';

export function useExternalEffectOutbox({ googleAuth, isOnline, updateSyncHealth }: {
    googleAuth: GoogleAuthStatus;
    isOnline: boolean;
    updateSyncHealth: (key: string, patch: Partial<SyncHealth>) => void;
}) {
    const enabled = isOnline && hasUsableAuth(googleAuth);
    const accountId = googleService.getAccountId();
    const summary = useLiveQuery(async () => summarizeExternalEffects(await db.agentProtocolEffects.toArray(), accountId), [accountId]);
    const scheduler = useRef<ReturnType<typeof createExternalEffectScheduler> | null>(null);

    useEffect(() => {
        const instance = createExternalEffectScheduler({
            drain: () => drainGoogleExternalEffects(),
            onError: () => updateSyncHealth('externalEffects', { state: 'error',
                detail: 'Frontu změn Google se nepodařilo načíst. Další pokus proběhne automaticky.',
                lastError: 'Místní fronta synchronizace není dostupná.' }),
        });
        scheduler.current = instance;
        return () => { instance.stop(); scheduler.current = null; };
    }, [updateSyncHealth]);

    useEffect(() => {
        scheduler.current?.setEnabled(enabled);
    }, [enabled, googleAuth.accessToken, accountId, updateSyncHealth]);

    const wakeKey = summary?.wakeKey;
    useEffect(() => { void scheduler.current?.wake(); }, [wakeKey]);

    useEffect(() => {
        if (!summary) return;
        const pendingDetail = summary.accountBlocked
            ? `${summary.pending} změn uloženo lokálně. Přihlaste se ke správnému účtu nebo u nepropojeného úkolu zvolte synchronizaci s Google.`
            : !enabled ? `${summary.pending} změn uloženo lokálně; čeká na připojení a přihlášení Google.`
            : `${summary.pending} změn uloženo lokálně; čeká na zápis do Google.`;
        updateSyncHealth('externalEffects', {
            label: 'Kalendář a Google Tasks',
            state: summary.failed ? 'error' : summary.pending ? 'stale' : 'ok',
            detail: summary.failed ? `${summary.failed} změn Google odmítl. Opravte úkol a zkuste synchronizaci znovu.`
                : summary.pending ? pendingDetail : 'Všechny čekající změny byly zapsány do Google.',
            lastError: summary.lastError,
            lastSuccess: summary.lastSuccess === null ? null : new Date(summary.lastSuccess).toLocaleString('cs-CZ'),
        });
    }, [summary, enabled, updateSyncHealth]);
}
