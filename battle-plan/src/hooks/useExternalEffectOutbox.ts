import { useEffect, useRef, useState } from 'react';
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
    const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
    const enabled = visible && isOnline && hasUsableAuth(googleAuth);
    const accountId = googleService.getAccountId();
    const summaries = useLiveQuery(async () => {
        const effects = await db.agentProtocolEffects.toArray();
        return {
            all: summarizeExternalEffects(effects, accountId),
            calendar: summarizeExternalEffects(effects.filter(effect => effect.kind === 'calendar'), accountId),
        };
    }, [accountId]);
    const summary = summaries?.all;
    const scheduler = useRef<ReturnType<typeof createExternalEffectScheduler> | null>(null);

    useEffect(() => {
        const changed = () => setVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', changed);
        return () => document.removeEventListener('visibilitychange', changed);
    }, []);

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
                : summary.pending ? pendingDetail : 'Žádné změny nečekají na přenos do Google.',
            lastError: summary.lastError,
            lastSuccess: summary.lastSuccess === null ? null : new Date(summary.lastSuccess).toLocaleString('cs-CZ'),
        });
    }, [summary, enabled, updateSyncHealth]);

    return summaries?.calendar;
}
