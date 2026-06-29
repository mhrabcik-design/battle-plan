import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type WorkLog, type Project } from '../../db';
import { WorkLogCard } from './WorkLogCard';

interface WorkLogCalendarProps {
    logs: WorkLog[];
    projects: Project[];
}

const COLOR_DOT: Record<string, string> = {
    slate: 'bg-slate-400',
    indigo: 'bg-indigo-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
};

/** YYYY-MM-01 → Date */
const monthKeyToDate = (key: string): Date => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1);
};

const currentMonthKey = (offset = 0): string => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthKeyToOffset = (key: string): number => {
    const [y, m] = key.split('-').map(Number);
    const now = new Date();
    const baseY = now.getFullYear();
    const baseM = now.getMonth() + 1;
    return (y - baseY) * 12 + (m - baseM);
};

const monthLabel = (key: string): string => {
    const d = monthKeyToDate(key);
    return d.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });
};

const isoDate = (year: number, month0: number, day: number): string => {
    return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const WEEKDAYS_CS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

export function WorkLogCalendar({ logs, projects }: WorkLogCalendarProps) {
    const [monthKey, setMonthKey] = useState(currentMonthKey(0));
    const [selectedDate, setSelectedDate] = useState<string | null>(null);

    // Mapa date → logs (pro rychlý lookup)
    const logsByDate = useMemo(() => {
        const map = new Map<string, WorkLog[]>();
        for (const l of logs) {
            if (!map.has(l.date)) map.set(l.date, []);
            map.get(l.date)!.push(l);
        }
        return map;
    }, [logs]);

    // Projekty → barva (lookup)
    const projectColors = useMemo(() => {
        const m = new Map<number, string>();
        for (const p of projects) m.set(p.id!, p.color);
        return m;
    }, [projects]);

    // Vygeneruj buňky kalendáře (7×N)
    const monthDate = monthKeyToDate(monthKey);
    const year = monthDate.getFullYear();
    const month0 = monthDate.getMonth();
    const firstWeekday = (new Date(year, month0, 1).getDay() + 6) % 7; // Po = 0
    const daysInMonth = new Date(year, month0 + 1, 0).getDate();
    const todayKey = isoDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

    const cells: Array<{ key: string; day: number | null; dateKey: string | null }> = [];
    for (let i = 0; i < firstWeekday; i++) {
        cells.push({ key: `pad-${i}`, day: null, dateKey: null });
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dk = isoDate(year, month0, d);
        cells.push({ key: dk, day: d, dateKey: dk });
    }
    // Zarovnej na celé týdny
    while (cells.length % 7 !== 0) {
        cells.push({ key: `tail-${cells.length}`, day: null, dateKey: null });
    }

    // Měsíční součty (header)
    const monthHours = useMemo(
        () => logs.filter((l) => l.date.startsWith(monthKey)).reduce((s, l) => s + l.hours, 0),
        [logs, monthKey]
    );
    const monthDays = useMemo(
        () => new Set(logs.filter((l) => l.date.startsWith(monthKey)).map((l) => l.date)).size,
        [logs, monthKey]
    );

    // Detail vybraného dne
    const selectedLogs = selectedDate ? logsByDate.get(selectedDate) ?? [] : [];
    const selectedHours = selectedLogs.reduce((s, l) => s + l.hours, 0);
    const selectedPeople = Array.from(new Set(selectedLogs.flatMap((l) => l.people.split(',').map((p) => p.trim()).filter(Boolean))));

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2 bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-1.5">
                    <button
                        type="button"
                        onClick={() => setMonthKey(currentMonthKey(monthKeyToOffset(monthKey) - 1))}
                        className="p-1.5 rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-all border border-slate-700/50"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setMonthKey(currentMonthKey(0))}
                        className="px-3 py-1 rounded-lg bg-slate-800/50 text-xs font-black text-white uppercase tracking-widest hover:bg-slate-700 transition-all border border-slate-700/50"
                    >
                        Dnes
                    </button>
                    <h3 className="text-sm font-black text-white uppercase tracking-tight min-w-[160px] text-center capitalize">
                        {monthLabel(monthKey)}
                    </h3>
                    <button
                        type="button"
                        onClick={() => setMonthKey(currentMonthKey(monthKeyToOffset(monthKey) + 1))}
                        className="p-1.5 rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-all border border-slate-700/50"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex items-center gap-3 text-xs">
                    <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-3 py-1.5">
                        <span className="text-slate-500 uppercase tracking-widest font-black">Celkem</span>{' '}
                        <span className="text-white font-black">{monthHours.toFixed(2)} h</span>
                    </div>
                    <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-3 py-1.5">
                        <span className="text-slate-500 uppercase tracking-widest font-black">Dnů</span>{' '}
                        <span className="text-white font-black">{monthDays}</span>
                    </div>
                </div>
            </div>

            {/* Grid kalendáře */}
            <div className="bg-slate-900/30 border border-slate-800 rounded-2xl overflow-hidden">
                {/* Hlavička — dny v týdnu */}
                <div className="grid grid-cols-7 border-b border-slate-800 bg-slate-900/50">
                    {WEEKDAYS_CS.map((d, i) => (
                        <div
                            key={d}
                            className={`px-2 py-2 text-xs font-black uppercase tracking-widest text-center ${
                                i >= 5 ? 'text-slate-600' : 'text-slate-400'
                            }`}
                        >
                            {d}
                        </div>
                    ))}
                </div>

                {/* Buňky */}
                <div className="grid grid-cols-7">
                    {cells.map((cell) => {
                        if (cell.day === null) {
                            return <div key={cell.key} className="min-h-[90px] bg-slate-950/20 border-r border-b border-slate-800/30" />;
                        }
                        const dayLogs = logsByDate.get(cell.dateKey!) ?? [];
                        const dayHours = dayLogs.reduce((s, l) => s + l.hours, 0);
                        const isToday = cell.dateKey === todayKey;
                        // Unikátní projekty v tomto dni (max 3 barvy)
                        const dayProjects = Array.from(
                            new Set(
                                dayLogs.map((l) => ({
                                    name: l.projectName,
                                    color: projectColors.get(l.projectId) ?? 'slate',
                                })).map((p) => JSON.stringify(p))
                            )
                        ).map((s) => JSON.parse(s)).slice(0, 3);
                        const moreCount = new Set(dayLogs.map((l) => l.projectName)).size - dayProjects.length;

                        return (
                            <button
                                key={cell.key}
                                type="button"
                                onClick={() => dayLogs.length > 0 && setSelectedDate(cell.dateKey)}
                                disabled={dayLogs.length === 0}
                                className={`min-h-[90px] p-2 border-r border-b border-slate-800/30 text-left transition-all relative ${
                                    dayLogs.length > 0 ? 'hover:bg-slate-800/40 cursor-pointer' : 'cursor-default'
                                } ${isToday ? 'bg-indigo-500/10 ring-1 ring-inset ring-indigo-500/40' : ''}`}
                            >
                                <div className={`text-xs font-black ${isToday ? 'text-indigo-400' : dayLogs.length > 0 ? 'text-white' : 'text-slate-600'}`}>
                                    {cell.day}
                                </div>
                                {dayLogs.length > 0 && (
                                    <>
                                        <div className="text-[10px] text-slate-400 mt-1 font-bold">
                                            {dayHours.toFixed(1)} h
                                        </div>
                                        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                                            {dayProjects.map((p) => (
                                                <span
                                                    key={p.name}
                                                    title={p.name}
                                                    className={`w-2 h-2 rounded-full ${COLOR_DOT[p.color] ?? COLOR_DOT.slate}`}
                                                />
                                            ))}
                                            {moreCount > 0 && (
                                                <span className="text-[9px] text-slate-500 font-bold">+{moreCount}</span>
                                            )}
                                        </div>
                                    </>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Legenda barev projektů */}
            {projects.filter((p) => p.isActive).length > 0 && (
                <div className="flex items-center gap-4 flex-wrap text-xs">
                    <span className="text-slate-500 uppercase tracking-widest font-black">Projekty:</span>
                    {projects.filter((p) => p.isActive).map((p) => (
                        <span key={p.id} className="flex items-center gap-1.5">
                            <span className={`w-2.5 h-2.5 rounded-full ${COLOR_DOT[p.color]}`} />
                            <span className="text-slate-300">{p.name}</span>
                        </span>
                    ))}
                </div>
            )}

            {/* Modal — detail dne */}
            <AnimatePresence>
                {selectedDate && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-md flex items-stretch justify-center overflow-y-auto"
                        onClick={() => setSelectedDate(null)}
                    >
                        <motion.div
                            initial={{ y: 20, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ y: 20, opacity: 0 }}
                            className="w-full max-w-2xl bg-slate-900 border-l border-white/5 shadow-2xl flex flex-col"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
                                <div>
                                    <h3 className="text-lg font-black text-white uppercase tracking-tight">
                                        {new Date(selectedDate).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })}
                                    </h3>
                                    <p className="text-xs text-slate-500 uppercase tracking-widest mt-1 font-bold">
                                        {selectedLogs.length} {selectedLogs.length === 1 ? 'záznam' : selectedLogs.length < 5 ? 'záznamy' : 'záznamů'} · {selectedHours.toFixed(2)} h
                                        {selectedPeople.length > 0 && ` · ${selectedPeople.join(', ')}`}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setSelectedDate(null)}
                                    className="p-2 text-slate-500 hover:text-white transition-all"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <div className="p-5 space-y-3 overflow-y-auto">
                                {selectedLogs.length === 0 ? (
                                    <div className="p-8 text-center text-slate-600 text-xs uppercase tracking-widest">
                                        Žádné záznamy
                                    </div>
                                ) : (
                                    selectedLogs.map((log) => (
                                        <WorkLogCard key={log.id} log={log} />
                                    ))
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}