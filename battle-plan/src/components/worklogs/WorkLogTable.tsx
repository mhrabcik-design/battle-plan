import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';
import { type WorkLog } from '../../db';

interface WorkLogTableProps {
    logs: WorkLog[];
    /** Když true, komponenta sama zobrazuje toolbar s měsícem + součty. Když false, je to "holá" tabulka (placeholder pro F4 calendar). */
    embedded?: boolean;
}

const COLOR_DOT: Record<string, string> = {
    slate: 'bg-slate-400',
    indigo: 'bg-indigo-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
};

/** Vrátí YYYY-MM první den aktuálního měsíce. */
const currentMonthKey = (offset = 0): string => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (key: string): string => {
    const [y, m] = key.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });
};

const dateInMonth = (date: string, monthKey: string): boolean => date.startsWith(monthKey);

/** Agreguje workLogy podle data, pak podle projektu v rámci dne. */
function aggregateByDay(logs: WorkLog[]) {
    // dayKey → projectName → { hours, people set, count }
    const days = new Map<string, Map<string, { hours: number; people: string[]; count: number }>>();
    for (const l of logs) {
        if (!days.has(l.date)) days.set(l.date, new Map());
        const dayMap = days.get(l.date)!;
        if (!dayMap.has(l.projectName)) {
            dayMap.set(l.projectName, { hours: 0, people: [], count: 0 });
        }
        const cell = dayMap.get(l.projectName)!;
        cell.hours += l.hours;
        cell.count += 1;
        if (l.people) {
            // sjednotit jména (split čárkou, trim, dedup)
            const incoming = l.people.split(',').map((s) => s.trim()).filter(Boolean);
            for (const name of incoming) {
                if (!cell.people.includes(name)) cell.people.push(name);
            }
        }
    }
    return days;
}

export function WorkLogTable({ logs, embedded = true }: WorkLogTableProps) {
    const [monthKey, setMonthKey] = useState(currentMonthKey(0));
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // Filtruj logy podle měsíce
    const monthLogs = useMemo(
        () => logs.filter((l) => dateInMonth(l.date, monthKey)),
        [logs, monthKey]
    );

    // Agregace den → projekt
    const daysMap = useMemo(() => aggregateByDay(monthLogs), [monthLogs]);

    // Dny v daném měsíci seřazené
    const sortedDays = useMemo(() => {
        return Array.from(daysMap.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [daysMap]);

    // Součty za měsíc
    const monthTotalHours = useMemo(
        () => monthLogs.reduce((sum, l) => sum + l.hours, 0),
        [monthLogs]
    );

    // Součty za projekt (v rámci měsíce) — pro patičku
    const projectTotals = useMemo(() => {
        const totals = new Map<string, number>();
        for (const l of monthLogs) {
            totals.set(l.projectName, (totals.get(l.projectName) ?? 0) + l.hours);
        }
        return Array.from(totals.entries()).sort(([, a], [, b]) => b - a);
    }, [monthLogs]);

    const toggleExpand = (day: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(day)) next.delete(day);
            else next.add(day);
            return next;
        });
    };

    if (!embedded) {
        // Placeholder pro F4 calendar — zatím prázdné
        return (
            <div className="p-12 text-center bg-slate-900/20 rounded-3xl border border-dashed border-slate-800">
                <CalendarIcon className="w-10 h-10 text-slate-800 mx-auto mb-3" />
                <p className="text-slate-500 font-bold uppercase text-xs tracking-widest">Kalendář (připravujeme)</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Toolbar: měsíc + součty */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2 bg-slate-900/50 border border-slate-800 rounded-xl px-3 py-1.5">
                    <button
                        type="button"
                        onClick={() => setMonthKey(currentMonthKey(monthKeyToOffset(monthKey) - 1))}
                        className="p-1.5 rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-all border border-slate-700/50"
                        title="Předchozí měsíc"
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
                    <h3 className="text-sm font-black text-white uppercase tracking-tight min-w-[140px] text-center capitalize">
                        {monthLabel(monthKey)}
                    </h3>
                    <button
                        type="button"
                        onClick={() => setMonthKey(currentMonthKey(monthKeyToOffset(monthKey) + 1))}
                        className="p-1.5 rounded-lg bg-slate-800/50 text-slate-400 hover:text-white transition-all border border-slate-700/50"
                        title="Další měsíc"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex items-center gap-3 text-xs">
                    <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-3 py-1.5">
                        <span className="text-slate-500 uppercase tracking-widest font-black">Celkem</span>{' '}
                        <span className="text-white font-black">{monthTotalHours.toFixed(2)} h</span>
                    </div>
                    <div className="bg-slate-900/50 border border-slate-800 rounded-lg px-3 py-1.5">
                        <span className="text-slate-500 uppercase tracking-widest font-black">Záznamů</span>{' '}
                        <span className="text-white font-black">{monthLogs.length}</span>
                    </div>
                </div>
            </div>

            {/* Tabulka */}
            <div className="bg-slate-900/30 border border-slate-800 rounded-2xl overflow-hidden">
                <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-900/60 border-b border-slate-800">
                            <tr className="text-left text-xs font-black text-slate-500 uppercase tracking-widest">
                                <th className="px-4 py-3">Datum</th>
                                <th className="px-4 py-3">Projekt</th>
                                <th className="px-4 py-3">Lidi</th>
                                <th className="px-4 py-3 text-right">Hodiny</th>
                                <th className="px-4 py-3 text-right">Detail</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedDays.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-4 py-12 text-center text-slate-600 text-xs uppercase tracking-widest">
                                        Žádné záznamy v tomto měsíci
                                    </td>
                                </tr>
                            ) : (
                                sortedDays.map(([date, projectsMap]) => {
                                    const isExpanded = expanded.has(date);
                                    const dayTotal = Array.from(projectsMap.values()).reduce((s, c) => s + c.hours, 0);
                                    const projects = Array.from(projectsMap.entries()).sort(([, a], [, b]) => b.hours - a.hours);
                                    return (
                                        <>
                                            <tr
                                                key={date}
                                                className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer"
                                                onClick={() => toggleExpand(date)}
                                            >
                                                <td className="px-4 py-3 font-black text-white whitespace-nowrap">
                                                    {new Date(date).toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'short' })}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className="text-slate-400 text-xs uppercase tracking-widest">
                                                        {projects.length} {projects.length === 1 ? 'projekt' : projects.length < 5 ? 'projekty' : 'projektů'}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-slate-500 text-xs">
                                                    {/* souhrn lidí za den */}
                                                    {Array.from(new Set(projects.flatMap(([, c]) => c.people))).join(', ') || '—'}
                                                </td>
                                                <td className="px-4 py-3 text-right font-black text-white">
                                                    {dayTotal.toFixed(2)}
                                                </td>
                                                <td className="px-4 py-3 text-right text-slate-500">
                                                    {isExpanded ? '▼' : '▶'}
                                                </td>
                                            </tr>
                                            {isExpanded && projects.map(([projectName, cell]) => (
                                                <tr key={`${date}-${projectName}`} className="bg-slate-950/40 border-b border-slate-800/30">
                                                    <td className="px-4 py-2"></td>
                                                    <td className="px-4 py-2">
                                                        <span className="flex items-center gap-2">
                                                            <span className={`w-2 h-2 rounded-full ${COLOR_DOT['slate']}`} />
                                                            <span className="text-white text-xs font-bold">{projectName}</span>
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-2 text-slate-400 text-xs">
                                                        {cell.people.join(', ') || '—'}
                                                    </td>
                                                    <td className="px-4 py-2 text-right text-white font-bold">
                                                        {cell.hours.toFixed(2)}
                                                    </td>
                                                    <td className="px-4 py-2 text-right text-slate-600 text-[10px] uppercase tracking-widest">
                                                        {cell.count}× záznam
                                                    </td>
                                                </tr>
                                            ))}
                                        </>
                                    );
                                })
                            )}
                        </tbody>
                        {/* Patička — součty za projekty v měsíci */}
                        {projectTotals.length > 0 && (
                            <tfoot className="bg-slate-900/60 border-t-2 border-slate-700">
                                <tr>
                                    <td colSpan={3} className="px-4 py-3 text-xs font-black text-slate-400 uppercase tracking-widest">
                                        Součty za {monthLabel(monthKey)}
                                    </td>
                                    <td className="px-4 py-3 text-right font-black text-white text-base">
                                        {monthTotalHours.toFixed(2)}
                                    </td>
                                    <td></td>
                                </tr>
                                {projectTotals.map(([name, hours]) => (
                                    <tr key={`total-${name}`} className="border-t border-slate-800/40">
                                        <td colSpan={3} className="px-4 py-1.5 text-xs text-slate-400 pl-8">
                                            ↳ {name}
                                        </td>
                                        <td className="px-4 py-1.5 text-right text-slate-300 text-xs font-bold">
                                            {hours.toFixed(2)}
                                        </td>
                                        <td></td>
                                    </tr>
                                ))}
                            </tfoot>
                        )}
                    </table>
                </div>
            </div>
        </div>
    );
}

// Helper — převede YYYY-MM klíč na offset měsíců od aktuálního
function monthKeyToOffset(key: string): number {
    const [y, m] = key.split('-').map(Number);
    const now = new Date();
    const baseY = now.getFullYear();
    const baseM = now.getMonth() + 1;
    return (y - baseY) * 12 + (m - baseM);
}