import { Fragment, useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type WorkLog } from '../../db';
import { currentMonthKey, monthKeyToOffset, monthLabel } from '../../utils/workLogMonth';
import {
    groupWorkLogsByProject,
    type WorkLogProjectIndex,
} from '../../utils/workLogProjectGrouping';
import { PROJECT_COLOR_DOT } from '../../utils/projectColors';

interface WorkLogTableProps {
    logs: WorkLog[];
    projectIndex: WorkLogProjectIndex;
}

const dateInMonth = (date: string, monthKey: string): boolean => date.startsWith(monthKey);

/** Agreguje workLogy podle data, pak podle projektu v rámci dne. */
function aggregateByDay(logs: WorkLog[], projectIndex: WorkLogProjectIndex) {
    const logsByDay = new Map<string, WorkLog[]>();
    for (const l of logs) {
        const day = logsByDay.get(l.date);
        if (day) day.push(l);
        else logsByDay.set(l.date, [l]);
    }
    return new Map(Array.from(logsByDay, ([date, dayLogs]) => [
        date,
        groupWorkLogsByProject(dayLogs, projectIndex).sort((a, b) => b.hours - a.hours),
    ]));
}

export function WorkLogTable({ logs, projectIndex }: WorkLogTableProps) {
    const [monthKey, setMonthKey] = useState(currentMonthKey(0));
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    // Filtruj logy podle měsíce
    const monthLogs = useMemo(
        () => logs.filter((l) => dateInMonth(l.date, monthKey)),
        [logs, monthKey]
    );

    // Agregace den → projekt
    const daysMap = useMemo(() => aggregateByDay(monthLogs, projectIndex), [monthLogs, projectIndex]);

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
        return groupWorkLogsByProject(monthLogs, projectIndex).sort((left, right) => right.hours - left.hours);
    }, [monthLogs, projectIndex]);

    const toggleExpand = (day: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(day)) next.delete(day);
            else next.add(day);
            return next;
        });
    };

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
                                sortedDays.map(([date, projectGroups]) => {
                                    const isExpanded = expanded.has(date);
                                    const dayTotal = projectGroups.reduce((sum, group) => sum + group.hours, 0);
                                    return (
                                        <Fragment key={date}>
                                            <tr
                                                className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer"
                                                onClick={() => toggleExpand(date)}
                                            >
                                                <td className="px-4 py-3 font-black text-white whitespace-nowrap">
                                                    {new Date(date).toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'short' })}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className="text-slate-400 text-xs uppercase tracking-widest">
                                                        {projectGroups.length} {projectGroups.length === 1 ? 'projekt' : projectGroups.length < 5 ? 'projekty' : 'projektů'}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-slate-500 text-xs">
                                                    {/* souhrn lidí za den */}
                                                    {Array.from(new Set(projectGroups.flatMap((group) => group.people))).join(', ') || '—'}
                                                </td>
                                                <td className="px-4 py-3 text-right font-black text-white">
                                                    {dayTotal.toFixed(2)}
                                                </td>
                                                <td className="px-4 py-3 text-right text-slate-500">
                                                    {isExpanded ? '▼' : '▶'}
                                                </td>
                                            </tr>
                                            {isExpanded && projectGroups.map((group) => (
                                                <tr key={`${date}-${group.key}`} className="bg-slate-950/40 border-b border-slate-800/30">
                                                    <td className="px-4 py-2"></td>
                                                    <td className="px-4 py-2">
                                                        <span className="flex items-center gap-2">
                                                            <span className={`w-2 h-2 rounded-full ${PROJECT_COLOR_DOT[group.color]}`} />
                                                            <span className="text-white text-xs font-bold">{group.name}</span>
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-2 text-slate-400 text-xs">
                                                        {group.people.join(', ') || '—'}
                                                    </td>
                                                    <td className="px-4 py-2 text-right text-white font-bold">
                                                        {group.hours.toFixed(2)}
                                                    </td>
                                                    <td className="px-4 py-2 text-right text-slate-600 text-[10px] uppercase tracking-widest">
                                                        {group.count}× záznam
                                                    </td>
                                                </tr>
                                            ))}
                                        </Fragment>
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
                                {projectTotals.map((group) => (
                                    <tr key={`total-${group.key}`} className="border-t border-slate-800/40">
                                        <td colSpan={3} className="px-4 py-1.5 text-xs text-slate-400 pl-8">
                                            ↳ {group.name}
                                        </td>
                                        <td className="px-4 py-1.5 text-right text-slate-300 text-xs font-bold">
                                            {group.hours.toFixed(2)}
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
