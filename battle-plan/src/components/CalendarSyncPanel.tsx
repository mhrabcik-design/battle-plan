import { useRef, useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';
import { googleService } from '../services/googleService';
import type { GoogleCalendarSyncControls } from '../hooks/useGoogleCalendarSync';
import type { CalendarSyncPreview } from '../services/googleCalendarSync';
import type { CalendarPublicProjection } from '../services/calendarModel';
import { toCalendarProjection } from '../services/calendarMapping';
import { calendarProjectionLabel, calendarTaskLabel } from '../utils/calendarPresentation';

const civilDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDate = (date: string, amount: number) => {
    const value = new Date(`${date}T12:00:00`);
    value.setDate(value.getDate() + amount);
    return Number.isFinite(value.getTime()) ? civilDate(value) : '';
};
const buttonClass = 'surface-action min-h-11 w-full gap-2 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-50';
const phaseLabels = { disabled: 'Vypnuto', offline: 'Čeká na připojení k internetu', 'auth-required': 'Obnovte Google přihlášení',
    hidden: 'Čeká na otevřenou aplikaci', checking: 'Kontroluji Kalendář…', ready: 'Kalendář je aktuální', error: 'Kontrola se nepodařila' };

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

export function CalendarSyncPanel({ controls, googleAuth, isOnline }: {
    controls: GoogleCalendarSyncControls; googleAuth: GoogleAuthStatus; isOnline: boolean;
}) {
    const { status } = controls;
    const [range, setRange] = useState(() => {
        const today = civilDate(new Date());
        return { startDate: shiftDate(today, -30), endDate: shiftDate(today, 179) };
    });
    const [preview, setPreview] = useState<CalendarSyncPreview | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const inFlight = useRef(false);
    const accountId = hasUsableAuth(googleAuth) && googleAuth.accessToken ? googleService.getAccountId() : null;
    const usable = !!accountId && isOnline;
    const currentPreview = preview?.accountId === accountId ? preview : null;
    const serviceRange = { startDate: range.startDate, endDate: shiftDate(range.endDate, 1) };
    const validRange = !!range.startDate && !!range.endDate && range.startDate <= range.endDate;
    const run = async (action: () => Promise<void>) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true); setError(''); setMessage('');
        try { await action(); } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Kalendář se nepodařilo aktualizovat. Zkuste to znovu.');
        } finally { inFlight.current = false; setBusy(false); }
    };
    const changeRange = (name: 'startDate' | 'endDate', value: string) => {
        setRange(previous => ({ ...previous, [name]: value }));
        setPreview(null); setSelected([]); setError('');
    };
    return <section aria-labelledby="calendar-sync-heading" className="min-w-0 space-y-3 border-t border-white/10 pt-4">
        <h3 id="calendar-sync-heading" className="flex items-center gap-2 text-sm font-bold text-white"><CalendarDays className="h-4 w-4" />Google Kalendář</h3>
        <p className="break-words text-xs text-slate-400">{accountId ? `Ověřený účet: ${accountId} · primární kalendář` : 'Pro propojení se přihlaste ke Googlu.'}</p>
        <p className="text-xs text-slate-500">Schůzky a naplánované bloky práce se synchronizují při otevřené aplikaci. Google Tasks zůstávají samostatné.</p>
        {!isOnline && <p role="status" className="text-sm text-amber-400">Jste offline. Změny čekají na připojení.</p>}
        <p role="status" className="text-sm font-semibold text-slate-300">{status ? phaseLabels[status.phase] : 'Načítám stav Kalendáře…'}</p>
        {status && <dl className="space-y-1 text-xs text-slate-400">
                <div><dt className="inline">Poslední kontrola: </dt><dd className="inline">{status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString('cs-CZ') : 'Zatím neproběhla'}</dd></div>
                <div><dt className="inline">Čekající změny: </dt><dd className="inline">{status.pending}</dd></div>
                <div><dt className="inline">Konflikty: </dt><dd className="inline">{status.conflicts.length}</dd></div>
            </dl>}
        {status?.enabled && <>
            {status.phase === 'auth-required' && <button type="button" className={buttonClass} onClick={() => googleService.signIn()}>Obnovit přihlášení</button>}
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                <button type="button" disabled={busy || !usable} className={buttonClass} onClick={() => { void run(() => controls.refresh()); }}><RefreshCw className="h-4 w-4" />Obnovit Kalendář</button>
                <button type="button" disabled={busy} className={buttonClass} onClick={() => { void run(async () => { await controls.disable(); setPreview(null); setSelected([]); setMessage('Propojení Kalendáře je vypnuté.'); }); }}>Vypnout propojení</button>
            </div>
        </>}
        {!status?.enabled && <>
            <p className="text-xs text-slate-400">Vyberte rozsah stávajících místních položek pro první export. Nové změny se potom přenášejí automaticky. Události z Googlu se načítají 30 dní zpět a 180 dní dopředu.</p>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="min-w-0 text-xs text-slate-400">Historie od<input aria-label="Historie od" type="date" value={range.startDate} disabled={busy} onChange={event => changeRange('startDate', event.target.value)} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-slate-900 px-2 text-sm text-white" /></label>
                <label className="min-w-0 text-xs text-slate-400">Do včetně<input aria-label="Historie do včetně" type="date" value={range.endDate} disabled={busy} onChange={event => changeRange('endDate', event.target.value)} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-slate-900 px-2 text-sm text-white" /></label>
            </div>
            <button type="button" disabled={busy || !usable || !validRange} className={`${buttonClass} border-indigo-500/40 bg-indigo-600 text-white`} onClick={() => { void run(async () => { setPreview(await controls.preview(serviceRange)); setSelected([]); }); }}>{busy ? 'Načítám…' : currentPreview ? 'Obnovit náhled' : 'Zobrazit náhled propojení'}</button>
            {currentPreview && <div className="min-w-0 space-y-3">
                <p className="text-xs text-slate-400">Náhled nic neodesílá. Zaškrtněte pouze položky, které chcete přenést.</p>
                {currentPreview.candidates.length === 0 ? <p className="text-sm text-slate-300">V tomto rozsahu nejsou žádné položky k exportu.</p> : <div className="max-h-64 space-y-2 overflow-y-auto">
                    {currentPreview.candidates.map(candidate => <label key={candidate.publicId} className="flex min-w-0 cursor-pointer gap-3 rounded-xl border border-white/10 p-3">
                        <input type="checkbox" checked={selected.includes(candidate.publicId)} disabled={busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, candidate.publicId] : previous.filter(id => id !== candidate.publicId))} className="mt-1 h-4 w-4 shrink-0 accent-indigo-500" />
                        <span className="min-w-0 space-y-1"><span className="block break-words text-sm font-semibold text-slate-200">{candidate.projection.title || 'Událost bez názvu'}</span><span className="block break-words text-xs text-slate-400">{candidate.type === 'task' ? 'Blok úkolu' : 'Schůzka'} · {calendarProjectionLabel(candidate.projection, currentPreview.timeZone)}</span></span>
                    </label>)}
                </div>}
                <button type="button" disabled={busy || !usable} className={`${buttonClass} border-emerald-500/40 bg-emerald-600 text-white`} onClick={() => { void run(async () => { await controls.activate({ range: currentPreview.range, selectedPublicIds: selected, timeZone: currentPreview.timeZone }); setPreview(null); setSelected([]); setMessage('Propojení Google Kalendáře je zapnuté.'); }); }}>Zapnout propojení · exportovat {selected.length} položek</button>
            </div>}
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
