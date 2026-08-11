import { useCallback, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Briefcase, Table2, Calendar as CalendarIcon, Filter, CopyCheck } from 'lucide-react';
import { db, type WorkLog } from '../db';
import { WorkLogForm } from '../components/worklogs/WorkLogForm';
import { WorkLogCard } from '../components/worklogs/WorkLogCard';
import { WorkLogTable } from '../components/worklogs/WorkLogTable';
import { WorkLogCalendar } from '../components/worklogs/WorkLogCalendar';
import { WorkLogVoiceBar, type WorkLogVoiceController } from '../components/worklogs/WorkLogVoiceBar';
import { ProjectManager } from '../components/worklogs/ProjectManager';
import { filterWorkLogsForPrace } from '../utils/workLogFilter';
import {
    createWorkLogProjectIndex,
    resolveWorkLogProjectDisplay,
} from '../utils/workLogProjectGrouping';
import {
    findExactWorkLogDuplicateGroups,
    type ExactWorkLogDuplicateGroup,
} from '../utils/workLogSyncIdentity';
import {
    confirmWorkLogDuplicateRepair,
    WorkLogDuplicateRepairStaleError,
} from '../services/workLogDuplicateRepair';
import { mergeLocalToCloud } from '../services/workLogsSync';

interface WorkLogsPageProps {
    onAddLog?: (message: string, type?: 'info' | 'error') => void;
    onVoiceControllerChange?: (controller: WorkLogVoiceController | null) => void;
}

type View = 'cards' | 'calendar' | 'table';

export function WorkLogsPage({ onAddLog, onVoiceControllerChange }: WorkLogsPageProps) {
    const [showForm, setShowForm] = useState(false);
    const [view, setView] = useState<View>('cards');
    const [repairingFingerprint, setRepairingFingerprint] = useState<string | null>(null);

    const logs = useLiveQuery(async () => {
        return await db.workLogs.orderBy('date').reverse().toArray();
    }, []);

    const projects = useLiveQuery(async () => {
        return await db.projects.toArray();
    }, []);

    const projectIndex = useMemo(
        () => createWorkLogProjectIndex(projects ?? []),
        [projects],
    );

    const { workLogs: effectiveLogs, hiddenCount } = useMemo(
        () => filterWorkLogsForPrace(logs ?? []),
        [logs],
    );

    const totalHours = useMemo(
        () => effectiveLogs.reduce((sum: number, l: WorkLog) => sum + l.hours, 0),
        [effectiveLogs],
    );

    const duplicateGroups = useMemo(
        () => findExactWorkLogDuplicateGroups(effectiveLogs),
        [effectiveLogs],
    );

    const handleSaved = useCallback(
        (log: WorkLog) => {
            onAddLog?.(`Činnost uložena: ${log.projectName} (${log.hours} h)`, 'info');
            setShowForm(false);
        },
        [onAddLog],
    );

    const handleVoiceError = useCallback(
        (msg: string) => onAddLog?.(msg, 'error'),
        [onAddLog],
    );

    const handleVoiceInfo = useCallback(
        (msg: string) => onAddLog?.(msg, 'info'),
        [onAddLog],
    );

    const handleDuplicateRepair = useCallback(async (
        group: ExactWorkLogDuplicateGroup,
    ) => {
        const log = group.survivor;
        const projectName = resolveWorkLogProjectDisplay(log, projectIndex).name;
        const confirmed = window.confirm(
            `Sloučit ${group.rows.length} obsahově stejných záznamů „${projectName}“ `
            + `ze dne ${log.date} do jednoho? Ponechá se nejnovější záznam.`,
        );
        if (!confirmed) return;

        setRepairingFingerprint(group.fingerprint);
        try {
            const result = await confirmWorkLogDuplicateRepair({
                fingerprint: group.fingerprint,
                rowIds: group.rows.map((row) => row.id),
            });
            // Pull unrelated cloud changes, but do not re-import the exact
            // sync identities that the user has just confirmed as copies.
            let cloudPublished = false;
            try {
                cloudPublished = await mergeLocalToCloud({
                    excludedWorkLogSyncIds: result.removedSyncIds,
                });
            } catch {
                cloudPublished = false;
            }
            onAddLog?.(
                cloudPublished
                    ? `Sloučeno: ${projectName}. Odstraněno kopií: ${result.removed}.`
                    : `Lokálně sloučeno: ${projectName}, ale Drive se nepodařilo aktualizovat. Při další synchronizaci se mohou kopie dočasně vrátit.`,
                cloudPublished ? 'info' : 'error',
            );
        } catch (error) {
            onAddLog?.(
                error instanceof WorkLogDuplicateRepairStaleError
                    ? 'Záznamy se mezitím změnily. Zkontrolujte nabídku znovu.'
                    : 'Sloučení kopií se nepodařilo. Žádný záznam nebyl odstraněn.',
                'error',
            );
        } finally {
            setRepairingFingerprint(null);
        }
    }, [onAddLog, projectIndex]);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                    <h2 className="text-xl font-black text-white uppercase tracking-tight">
                        Pracovní činnosti
                    </h2>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">
                        Večerní diktování → měsíční přehled
                        {hiddenCount > 0 && (
                            <span
                                className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 normal-case tracking-normal"
                                title="Automaticky skryté záznamy, které vypadají jako schůze / jednání. Práce eviduje jen reálnou manuální práci."
                            >
                                <Filter className="w-3 h-3" />
                                {hiddenCount} skryto jako schůze
                            </span>
                        )}
                    </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                    {/* View toggle */}
                    <div className="flex items-center bg-slate-900/50 border border-slate-800 rounded-xl p-1">
                        <button
                            type="button"
                            onClick={() => setView('cards')}
                            className={`p-1.5 rounded-lg transition-all ${
                                view === 'cards' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-white'
                            }`}
                            title="Karty"
                        >
                            <Briefcase className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setView('calendar')}
                            className={`p-1.5 rounded-lg transition-all ${
                                view === 'calendar' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-white'
                            }`}
                            title="Kalendář (F4)"
                        >
                            <CalendarIcon className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setView('table')}
                            className={`p-1.5 rounded-lg transition-all ${
                                view === 'table' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:text-white'
                            }`}
                            title="Tabulka"
                        >
                            <Table2 className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-4 py-2 text-right">
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Celkem</div>
                        <div className="text-lg font-black text-white">
                            {totalHours.toFixed(2)} <span className="text-xs text-slate-500">h</span>
                        </div>
                    </div>

                    {/* Voice vstup — přímo v hlavičce Práce, vedle „Přidat činnost" */}
                    <WorkLogVoiceBar
                        onSaved={handleSaved}
                        onError={handleVoiceError}
                        onInfo={handleVoiceInfo}
                        onControllerChange={onVoiceControllerChange}
                    />

                    <button
                        type="button"
                        onClick={() => setShowForm((s) => !s)}
                        className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all"
                    >
                        {showForm ? 'Zavřít' : (
                            <>
                                <Plus className="w-4 h-4" />
                                Přidat činnost
                            </>
                        )}
                    </button>
                </div>
            </div>

            <ProjectManager onMessage={onAddLog} />

            {duplicateGroups.length > 0 && (
                <section
                    aria-label="Možné duplicitní pracovní záznamy"
                    className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3"
                >
                    <div className="flex items-start gap-3">
                        <CopyCheck className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                        <div>
                            <h3 className="text-sm font-black text-amber-100 uppercase tracking-wide">
                                Nalezeny možné kopie záznamů
                            </h3>
                            <p className="text-xs text-amber-200/70 mt-1">
                                Zkontrolujte je a potvrďte sloučení. Bez potvrzení se nic nemaže.
                            </p>
                        </div>
                    </div>
                    <div className="space-y-2">
                        {duplicateGroups.map((group) => {
                            const log = group.survivor;
                            const projectName = resolveWorkLogProjectDisplay(log, projectIndex).name;
                            const isRepairing = repairingFingerprint === group.fingerprint;
                            return (
                                <div
                                    key={group.fingerprint}
                                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-slate-950/40 p-3"
                                >
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold text-white truncate" title={projectName}>
                                            {projectName}
                                        </p>
                                        <p className="text-xs text-slate-400 mt-1">
                                            {log.date} · {log.hours.toFixed(2)} h · {group.rows.length} stejné záznamy
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={repairingFingerprint !== null}
                                        onClick={() => void handleDuplicateRepair(group)}
                                        className="shrink-0 rounded-lg bg-amber-500 px-3 py-2 text-xs font-black uppercase tracking-wide text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isRepairing ? 'Slučuji…' : `Sloučit ${group.rows.length} na 1`}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* Formulář */}
            {showForm && (
                <WorkLogForm
                    onSaved={handleSaved}
                    onCancel={() => setShowForm(false)}
                />
            )}

            {/* Pohled */}
            {logs === undefined || projects === undefined ? (
                <div
                    role="status"
                    className="p-10 text-center bg-slate-900/20 rounded-3xl border border-dashed border-slate-800"
                >
                    <Briefcase className="w-8 h-8 text-slate-700 mx-auto mb-3 animate-pulse" />
                    <p className="text-slate-500 font-bold uppercase text-xs tracking-widest">
                        Načítám záznamy a projekty…
                    </p>
                </div>
            ) : (
                <>
                    {view === 'cards' && (
                        effectiveLogs.length === 0 ? (
                            <div className="p-16 text-center bg-slate-900/20 rounded-3xl border border-dashed border-slate-800">
                                <Briefcase className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                                <p className="text-slate-500 font-bold uppercase text-xs tracking-widest mb-2">
                                    Zatím žádné záznamy
                                </p>
                                <p className="text-slate-600 text-xs">
                                    Přidej první činnost tlačítkem nahoře, nebo nadikuj večer co jsi dělal.
                                </p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {effectiveLogs.map((log) => (
                                    <WorkLogCard key={log.id} log={log} projectIndex={projectIndex} />
                                ))}
                            </div>
                        )
                    )}

                    {view === 'calendar' && (
                        <WorkLogCalendar logs={effectiveLogs} projects={projects} projectIndex={projectIndex} />
                    )}

                    {view === 'table' && (
                        <WorkLogTable logs={effectiveLogs} projectIndex={projectIndex} />
                    )}
                </>
            )}
        </div>
    );
}
