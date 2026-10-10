import type { CalendarSyncStatus } from '../services/googleCalendarSync.ts';
import type { summarizeExternalEffects } from '../services/externalEffectOutbox.ts';

export type CalendarEffectSummary = ReturnType<typeof summarizeExternalEffects>;
export type CalendarIndicatorState = 'neutral' | 'pending' | 'syncing' | 'synced' | 'error';

export interface CalendarIndicator {
    state: CalendarIndicatorState;
    label: string;
    detail: string;
    pending: number;
}

export function getCalendarSyncIndicator({ status, effects, accountId, isOnline, authenticated }: {
    status?: CalendarSyncStatus;
    effects?: CalendarEffectSummary;
    accountId: string | null;
    isOnline: boolean;
    authenticated: boolean;
}): CalendarIndicator {
    const pending = effects?.pending ?? 0;
    const show = (state: CalendarIndicatorState, label: string, detail: string): CalendarIndicator => ({ state, label, detail, pending });
    if (!effects || !status) return show('neutral', 'Načítám stav', 'Zjišťuji stav synchronizace s Google Kalendářem.');
    const current = status.accountId === accountId;
    if (effects.failed) return show('error', 'Chyba synchronizace', 'Některé změny se nepodařilo přenést. Podrobnosti najdete v nastavení a diagnostice.');
    if (current && status.conflicts.length) return show('error', 'Vyřešit konflikt', 'Místní změny se liší od Google Kalendáře. V nastavení vyberte, kterou verzi zachovat.');
    if (current && status.phase === 'error') return show('error', 'Chyba synchronizace', status.error || 'Kalendář se nepodařilo zkontrolovat. Další pokus proběhne automaticky.');
    if (pending) {
        if (!isOnline) return show('pending', 'Není synchronizováno', 'Změny jsou uložené lokálně a čekají na připojení k internetu.');
        if (!authenticated || !accountId || effects.accountBlocked) return show('pending', 'Není synchronizováno', 'Změny jsou uložené lokálně. Obnovte přihlášení ke správnému Google účtu; nepropojenou položku můžete připojit ručně.');
        if (effects.running || current && status.phase === 'checking') return show('syncing', 'Synchronizuji…', 'Probíhá přenos změn nebo kontrola Google Kalendáře.');
        return show('pending', 'Není synchronizováno', status.enabled ? 'Změny čekají na přenos do Google Kalendáře.' : 'Změny jsou uložené lokálně. Automatická synchronizace je vypnutá.');
    }
    if (!authenticated || !accountId) return show('neutral', 'Kalendář nepřipojen', 'Pro synchronizaci se přihlaste ke Googlu v nastavení.');
    if (!current) return show('neutral', 'Načítám stav', 'Zjišťuji stav Kalendáře právě přihlášeného účtu.');
    if (!status.enabled) return show('neutral', 'Synchronizace vypnutá', 'Automatickou synchronizaci s Google Kalendářem můžete zapnout v nastavení.');
    if (!isOnline || status.phase === 'offline') return show('neutral', 'Offline', 'Stav Google Kalendáře bude zkontrolován po obnovení připojení.');
    if (status.phase === 'auth-required') return show('neutral', 'Obnovit přihlášení', 'Pro kontrolu Google Kalendáře obnovte přihlášení v nastavení.');
    if (status.phase === 'checking') return show('syncing', 'Synchronizuji…', 'Kontroluji změny v Google Kalendáři.');
    if (status.phase === 'hidden' || !status.lastCheckedAt) return show('neutral', 'Čeká na kontrolu', 'Synchronizace probíhá při otevřené aplikaci.');
    return show('synced', 'Synchronizováno', 'Žádné změny nečekají na přenos do Google Kalendáře.');
}
