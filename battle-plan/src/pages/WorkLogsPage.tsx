import { useCallback, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Briefcase, Table2, Calendar as CalendarIcon, Filter } from 'lucide-react';
import { db, type WorkLog } from '../db';
import { WorkLogForm } from '../components/worklogs/WorkLogForm';
import { WorkLogCard } from '../components/worklogs/WorkLogCard';
import { WorkLogTable } from '../components/worklogs/WorkLogTable';
import { WorkLogCalendar } from '../components/worklogs/WorkLogCalendar';
import { WorkLogVoiceBar } from '../components/worklogs/WorkLogVoiceBar';
import { filterWorkLogsForPrace } from '../utils/workLogFilter';

interface WorkLogsPageProps {
    googleAuth: { isSignedIn: boolean; accessToken: string | null };
    onAddLog?: (message: string, type?: 'info' | 'error') => void;
}

type View = 'cards' | 'calendar' | 'table';

export function WorkLogsPage({ onAddLog }: WorkLogsPageProps) {
    const [showForm, setShowForm] = useState(false);
    const [view, setView] = useState<View>('cards');

    const logs = useLiveQuery(async () => {
        return await db.workLogs.orderBy('date').reverse().toArray();
    }, []);

    const projects = useLiveQuery(async () => {
        return await db.projects.toArray();
    }, []) ?? [];

    const { workLogs: effectiveLogs, hiddenCount } = useMemo(
        () => filterWorkLogsForPrace(logs ?? []),
        [logs],
    );

    const totalHours = useMemo(
        () => effectiveLogs.reduce((sum: number, l: WorkLog) => sum + l.hours, 0),
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

            {/* Formulář */}
            {showForm && (
                <WorkLogForm
                    onSaved={handleSaved}
                    onCancel={() => setShowForm(false)}
                />
            )}

            {/* Pohled */}
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
                            <WorkLogCard key={log.id} log={log} />
                        ))}
                    </div>
                )
            )}

            {view === 'calendar' && (
                <WorkLogCalendar logs={effectiveLogs} projects={projects} />
            )}

            {view === 'table' && (
                <WorkLogTable logs={effectiveLogs} embedded={true} />
            )}
        </div>
    );
}
