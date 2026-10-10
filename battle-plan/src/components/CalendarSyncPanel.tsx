import { useRef, useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';
import { googleService } from '../services/googleService';
import type { GoogleCalendarSyncControls } from '../hooks/useGoogleCalendarSync';
import type { CalendarPublicProjection } from '../services/calendarModel';
import { toCalendarProjection } from '../services/calendarMapping';
import { calendarProjectionLabel, calendarTaskLabel } from '../utils/calendarPresentation';
import type { CalendarIndicator } from '../utils/calendarSyncIndicator';
const buttonClass = 'surface-action min-h-11 w-full gap-2 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50';

function ConflictVersion({ label, projection, deleted, timeZone }: { label: string; projection?: CalendarPublicProjection; deleted: boolean; timeZone: string }) {
    return <div className="min-w-0 space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
        <h5 className="font-bold text-white">{label}</h5>
        {deleted ? <p className="text-red-400">Smazaná událost</p> : projection ? <>
            <p className="break-words font-semibold text-slate-200">{projection.title || 'Událost bez názvu'}</p>
            <p className="whitespace-pre-wrap break-words text-slate-400">{projection.description || 'Bez veřejného popisu'}</p>
            <p className="break-words text-xs text-slate-300">{calendarProjectionLabel(projection, timeZone)}</p>
        </> : <p className="text-slate-400">Verze není dostupná</p>}
    </div>;
}

export function CalendarSyncPanel({ controls, googleAuth, isOnline, indicator }: {
    controls: GoogleCalendarSyncControls; googleAuth: GoogleAuthStatus; isOnline: boolean;
    indicator: CalendarIndicator;
}) {
    const { status } = controls;
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const inFlight = useRef(false);
    const accountId = hasUsableAuth(googleAuth) && googleAuth.accessToken ? googleService.getAccountId() : null;
    const usable = !!accountId && isOnline;
    const run = async (action: () => Promise<void>) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true); setError(''); setMessage('');
        try { await action(); } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Kalendář se nepodařilo aktualizovat. Zkuste to znovu.');
        } finally { inFlight.current = false; setBusy(false); }
    };
    return <section aria-labelledby="calendar-sync-heading" className="min-w-0 space-y-3 border-t border-white/10 pt-4">
        <h3 id="calendar-sync-heading" className="flex items-center gap-2 text-sm font-bold text-white"><CalendarDays className="h-4 w-4" />Google Kalendář</h3>
        <p className="break-words text-xs text-slate-400">{accountId ? `Ověřený účet: ${accountId} · primární kalendář` : 'Pro propojení se přihlaste ke Googlu.'}</p>
        <p className="text-xs text-slate-500">Po zapnutí se všechny stávající i nové schůzky a naplánované bloky práce přenášejí automaticky oběma směry při otevřené aplikaci. Google Tasks zůstávají samostatné.</p>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-white/10 p-3">
            <input type="checkbox" checked={status?.enabled ?? false} disabled={busy || !status || (!status.enabled && !usable)}
                onChange={event => {
                    const enabled = event.target.checked;
                    void run(async () => {
                        if (enabled) await controls.activate(); else await controls.disable();
                        setMessage(enabled ? 'Synchronizace Google Kalendáře je zapnutá.' : 'Synchronizace Google Kalendáře je vypnutá.');
                    });
                }} className="h-4 w-4 shrink-0 accent-indigo-500" />
            <span className="min-w-0 break-words text-sm font-semibold text-slate-200">Synchronizovat s Google Kalendářem</span>
        </label>
        {!isOnline && <p role="status" className="text-sm text-amber-400">Jste offline. Změny čekají na připojení.</p>}
        <p role="status" className="calendar-sync-indicator text-sm font-semibold" data-state={indicator.state}>{indicator.label}</p>
        <p className="text-xs text-slate-400">{indicator.detail}</p>
        {status && <dl className="space-y-1 text-xs text-slate-400">
                <div><dt className="inline">Poslední kontrola: </dt><dd className="inline">{status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString('cs-CZ') : 'Zatím neproběhla'}</dd></div>
                <div><dt className="inline">Čekající změny: </dt><dd className="inline">{indicator.pending}</dd></div>
                <div><dt className="inline">Konflikty: </dt><dd className="inline">{status.conflicts.length}</dd></div>
            </dl>}
        {status?.enabled && <>
            {status.phase === 'auth-required' && <button type="button" className={buttonClass} onClick={() => googleService.signIn()}>Obnovit přihlášení</button>}
            <button type="button" disabled={busy || !usable} className={buttonClass} onClick={() => { void run(() => controls.refresh()); }}><RefreshCw className="h-4 w-4" />Obnovit Kalendář</button>
        </>}
        {!!status?.conflicts.length && <div className="space-y-3">
            <h4 className="text-sm font-bold text-amber-400">Rozhodněte o konfliktech</h4>
            {status.conflicts.map(task => {
                const conflict = task.calendar!.conflict!;
                const local = task.isDeleted ? undefined : toCalendarProjection(task, status.timeZone) ?? conflict.local;
                const differences = conflict.fields.map(field => ({ title: 'název', description: 'veřejný popis', timing: 'čas a datum' })[field]);
                const resolve = (choice: 'google' | 'battleplan') => run(async () => {
                    const result = await controls.resolveConflict(task.publicId!, choice, { revisionId: task.protocolRevision?.revision_id ?? null, metadataUpdatedAt: task.calendar!.metadataUpdatedAt });
                    setMessage(result === 'stale' ? 'Událost se mezitím změnila. Níže je aktuální konflikt; porovnejte verze a zvolte znovu.' : 'Konflikt je vyřešený.');
                });
                return <article key={task.publicId} className="min-w-0 space-y-3 rounded-2xl border border-amber-500/30 p-3">
                    <h5 className="break-words text-sm font-semibold text-white">{calendarTaskLabel(task)}</h5>
                    <p className="text-xs text-slate-400">{conflict.kind === 'remote-deleted' ? 'Událost byla smazána v Googlu.' : conflict.kind === 'local-deleted' ? 'Událost byla smazána v Battleplanu.' : `Rozdíly: ${differences.join(', ') || 'chybí společná verze'}.`}</p>
                    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                        <ConflictVersion label="Battleplan" projection={local} deleted={!!task.isDeleted || conflict.kind === 'local-deleted'} timeZone={status.timeZone} />
                        <ConflictVersion label="Google Kalendář" projection={conflict.remote} deleted={conflict.kind === 'remote-deleted'} timeZone={status.timeZone} />
                    </div>
                    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                        <button type="button" disabled={busy || !usable} className={buttonClass} onClick={() => { void resolve('google'); }}>Použít Google</button>
                        <button type="button" disabled={busy || !usable || !!task.calendar?.readonlyReason} className={buttonClass} onClick={() => { void resolve('battleplan'); }}>Použít Battleplan</button>
                    </div>
                    {task.calendar?.readonlyReason && <p className="text-xs text-slate-400">Tato událost je pouze pro čtení. Změny provádějte v Google Kalendáři.</p>}
                </article>;
            })}
        </div>}
        {(error || status?.error) && <p role="alert" className="break-words text-sm text-red-400">{error || status?.error}</p>}
        {message && <p role="status" className="break-words text-sm text-emerald-400">{message}</p>}
    </section>;
}
