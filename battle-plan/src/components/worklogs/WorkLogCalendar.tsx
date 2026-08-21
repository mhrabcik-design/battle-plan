import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Filter, X } from 'lucide-react';
import { type WorkLog } from '../../db';
import { currentMonthKey, monthKeyToDate, monthKeyToOffset, monthLabel } from '../../utils/workLogMonth';
import { PROJECT_COLOR_DOT } from '../../utils/projectColors';
import {
    filterWorkLogsByProjectKey,
    groupWorkLogsByProject,
    type WorkLogProjectIndex,
} from '../../utils/workLogProjectGrouping';
import { WorkLogCard } from './WorkLogCard';
import { OverlaySurface } from '../ui/OverlaySurface';

interface WorkLogCalendarProps {
    logs: WorkLog[];
    projectIndex: WorkLogProjectIndex;
}

const ALL_PROJECTS = '';

const isoDate = (year: number, month0: number, day: number): string => {
    return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const WEEKDAYS_CS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

export function WorkLogCalendar({ logs, projectIndex }: WorkLogCalendarProps) {
    const [monthKey, setMonthKey] = useState(currentMonthKey(0));
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [selectedProjectKey, setSelectedProjectKey] = useState(ALL_PROJECTS);

    const projectOptions = useMemo(
        () => groupWorkLogsByProject(logs, projectIndex)
            .sort((left, right) => left.name.localeCompare(right.name, 'cs')),
        [logs, projectIndex],
    );
    const activeProjectKey = selectedProjectKey === ALL_PROJECTS
        || projectOptions.some((project) => project.key === selectedProjectKey)
        ? selectedProjectKey
        : ALL_PROJECTS;
    const filteredLogs = useMemo(
        () => activeProjectKey === ALL_PROJECTS
            ? logs
            : filterWorkLogsByProjectKey(logs, activeProjectKey, projectIndex),
        [activeProjectKey, logs, projectIndex],
    );

    // Mapa date → logs (pro rychlý lookup)
    const logsByDate = useMemo(() => {
        const map = new Map<string, WorkLog[]>();
        for (const l of filteredLogs) {
            if (!map.has(l.date)) map.set(l.date, []);
            map.get(l.date)!.push(l);
        }
        return map;
    }, [filteredLogs]);
    const projectGroupsByDate = useMemo(
        () => new Map(Array.from(logsByDate, ([date, dayLogs]) => [
            date,
            groupWorkLogsByProject(dayLogs, projectIndex),
        ])),
        [logsByDate, projectIndex],
    );

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
        () => filteredLogs.filter((l) => l.date.startsWith(monthKey)).reduce((s, l) => s + l.hours, 0),
        [filteredLogs, monthKey]
    );
    const monthDays = useMemo(
        () => new Set(filteredLogs.filter((l) => l.date.startsWith(monthKey)).map((l) => l.date)).size,
        [filteredLogs, monthKey]
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
                        className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-[background-color,border-color,color] border border-slate-700/50"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setMonthKey(currentMonthKey(0))}
                        className="min-h-11 px-3 py-1 rounded-lg bg-slate-800/50 text-xs font-black text-white uppercase tracking-widest hover:bg-slate-700 transition-[background-color,border-color,color] border border-slate-700/50"
                    >
                        Dnes
                    </button>
                    <h3 className="text-sm font-black text-white uppercase tracking-tight min-w-[160px] text-center capitalize">
                        {monthLabel(monthKey)}
                    </h3>
                    <button
                        type="button"
                        onClick={() => setMonthKey(currentMonthKey(monthKeyToOffset(monthKey) + 1))}
                        className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-[background-color,border-color,color] border border-slate-700/50"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex items-center gap-3 text-xs flex-wrap">
                    <label className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-1.5">
                        <Filter className="h-3.5 w-3.5 shrink-0 text-indigo-400" aria-hidden="true" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                            Projekt
                        </span>
                        <select
                            value={activeProjectKey}
                            onChange={(event) => {
                                setSelectedProjectKey(event.target.value);
                                setSelectedDate(null);
                            }}
                            className="min-w-0 max-w-[220px] bg-transparent text-xs font-bold text-white outline-none sm:min-w-[160px]"
                            aria-label="Filtrovat kalendář podle projektu"
                        >
                            <option value={ALL_PROJECTS} className="bg-slate-900">
                                Všechny projekty
                            </option>
                            {projectOptions.map((project) => (
                                <option key={project.key} value={project.key} className="bg-slate-900">
                                    {project.name}
                                </option>
                            ))}
                        </select>
                    </label>
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
            <div className="custom-scrollbar overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/30" tabIndex={0} aria-label="Měsíční kalendář, vodorovně posuvný">
                <div className="min-w-[784px]">
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
                        const allDayProjects = projectGroupsByDate.get(cell.dateKey!) ?? [];
                        const dayProjects = allDayProjects.slice(0, 3);
                        const moreCount = allDayProjects.length - dayProjects.length;

                        return (
                            <button
                                key={cell.key}
                                type="button"
                                onClick={() => dayLogs.length > 0 && setSelectedDate(cell.dateKey)}
                                disabled={dayLogs.length === 0}
                                className={`min-h-[90px] p-2 border-r border-b border-slate-800/30 text-left transition-[background-color,border-color,color,opacity] relative ${
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
                                                    className={`w-2 h-2 rounded-full ${PROJECT_COLOR_DOT[p.color] ?? PROJECT_COLOR_DOT.slate}`}
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
            </div>

            {/* Legenda barev projektů */}
            {projectOptions.length > 0 && (
                <div className="flex items-center gap-4 flex-wrap text-xs">
                    <span className="text-slate-500 uppercase tracking-widest font-black">Projekty:</span>
                    {projectOptions
                        .filter((project) => activeProjectKey === ALL_PROJECTS || project.key === activeProjectKey)
                        .map((project) => (
                        <span key={project.key} className="flex items-center gap-1.5">
                            <span className={`w-2.5 h-2.5 rounded-full ${PROJECT_COLOR_DOT[project.color]}`} />
                            <span className="text-slate-300">{project.name}</span>
                        </span>
                    ))}
                </div>
            )}

            {/* Modal — detail dne */}
            {selectedDate && (
                <OverlaySurface
                    title={`Detail dne ${selectedDate}`}
                    onRequestClose={() => setSelectedDate(null)}
                    variant="sheet"
                    className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-white/10 bg-slate-900 shadow-2xl"
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
                                    aria-label="Zavřít detail dne"
                                    className="surface-action h-11 w-11 text-slate-400 hover:text-white"
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
                                        <WorkLogCard key={log.id} log={log} projectIndex={projectIndex} />
                                    ))
                                )}
                            </div>
                </OverlaySurface>
            )}
        </div>
    );
}
