import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Save, X, AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { db, type Project, type WorkLog } from '../../db';
import { ProjectPicker } from './ProjectPicker';
import { findProjectByName, type ApplyResult, type ExtractedWorkLog, type ExtractedWorkLogBatch } from '../../services/workLogExtractor';
import { hasExplainedPersonHours } from '../../utils/workLogBatch';

interface WorkLogVoiceConfirmProps {
    extracted: ExtractedWorkLogBatch;
    onConfirmed: (result: ApplyResult) => void;
    onCancelled: () => void;
}

type EditableEntry = ExtractedWorkLog & {
    localId: string;
    project: Project | null;
};

const parseHours = (value: number | string | undefined): number => {
    const parsed = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(',', '.'));
    return Number.isNaN(parsed) ? 0 : parsed;
};

const peopleCountFromText = (people: string): number =>
    people.split(',').map((p) => p.trim()).filter(Boolean).length;

export function WorkLogVoiceConfirm({ extracted, onConfirmed, onCancelled }: WorkLogVoiceConfirmProps) {
    const [entries, setEntries] = useState<EditableEntry[]>(
        extracted.entries.map((entry, index) => ({
            ...entry,
            localId: `${entry.date}-${index}-${entry.projectName}`,
            project: null,
        })),
    );
    const [saving, setSaving] = useState(false);

    const totalHours = useMemo(
        () => entries.reduce((sum, entry) => sum + parseHours(entry.hours), 0),
        [entries],
    );

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const projects = await db.projects.toArray();
            if (cancelled) return;
            const activeProjects = projects.filter((p) => p.isActive);
            setEntries((prev) =>
                prev.map((entry) => {
                    if (entry.project || !entry.projectName) return entry;
                    const project = findProjectByName(entry.projectName, activeProjects);
                    return project ? { ...entry, project } : entry;
                }),
            );
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const updateEntry = (localId: string, updates: Partial<EditableEntry>) => {
        setEntries((prev) => prev.map((entry) => {
            if (entry.localId !== localId) return entry;
            const next = { ...entry, ...updates };
            if ('hoursPerPerson' in updates || 'people' in updates) {
                const hoursPerPerson = parseHours(next.hoursPerPerson);
                const peopleCount = peopleCountFromText(next.people);
                if (hoursPerPerson > 0 && peopleCount > 0) {
                    const total = Math.round(hoursPerPerson * peopleCount * 100) / 100;
                    next.hours = total;
                    next.peopleCount = peopleCount;
                    next.calculationNote = `${peopleCount} ${peopleCount === 1 ? 'člověk' : peopleCount < 5 ? 'lidé' : 'lidí'} × ${hoursPerPerson} h = ${total} h`;
                }
            }
            return next;
        }));
    };

    const removeEntry = (localId: string) => {
        setEntries((prev) => prev.filter((entry) => entry.localId !== localId));
    };

    const handleSave = async () => {
        if (entries.length === 0) {
            alert('Není co uložit.');
            return;
        }

        const invalid = entries.find((entry) => {
            const hours = parseHours(entry.hours);
            return !entry.project || !entry.date || hours <= 0 || !hasExplainedPersonHours(hours, entry.peopleCount, entry.hoursPerPerson);
        });
        if (invalid) {
            alert('Zkontrolujte projekt, datum a výpočet hodin u všech řádků.');
            return;
        }

        setSaving(true);
        const now = Date.now();
        const batchId = `voice-${now}`;
        try {
            const saved: WorkLog[] = [];
            await db.transaction('rw', db.workLogs, async () => {
                for (const entry of entries) {
                    const project = entry.project!;
                    const workLog: Omit<WorkLog, 'id'> = {
                        date: entry.date,
                        projectId: project.id!,
                        projectName: project.name,
                        people: entry.people.trim(),
                        hours: parseHours(entry.hours),
                        hoursPerPerson: entry.hoursPerPerson,
                        peopleCount: entry.peopleCount,
                        calculationNote: entry.calculationNote,
                        assumptions: [...extracted.assumptions, ...(entry.assumptions ?? [])].filter(Boolean),
                        extractionBatchId: batchId,
                        description: entry.description?.trim() || undefined,
                        source: 'voice',
                        createdAt: now,
                        updatedAt: now,
                    };
                    const id = await db.workLogs.add(workLog);
                    saved.push({ id: id as number, ...workLog });
                }
            });

            onConfirmed({
                ok: true,
                workLog: saved[0],
                workLogs: saved,
            });
        } finally {
            setSaving(false);
        }
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[120] bg-slate-950/80 backdrop-blur-md flex items-stretch justify-center overflow-y-auto"
                onClick={onCancelled}
            >
                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 20, opacity: 0 }}
                    className="w-full max-w-5xl bg-slate-900 border-l border-white/5 shadow-2xl flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="p-5 border-b border-slate-800 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400">
                                <Mic className="w-5 h-5" />
                            </div>
                            <div>
                                <h3 className="text-lg font-black text-white uppercase tracking-tight">
                                    Ověř diktování práce
                                </h3>
                                <p className="text-xs text-slate-500 uppercase tracking-widest mt-1 font-bold">
                                    {entries.length} {entries.length === 1 ? 'návrh' : entries.length < 5 ? 'návrhy' : 'návrhů'} · {totalHours.toFixed(2)} h celkem
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={onCancelled}
                            className="p-2 text-slate-500 hover:text-white transition-all"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="p-5 space-y-4 overflow-y-auto">
                        {(extracted.needsConfirmation || extracted.confirmationReasons.length > 0 || extracted.assumptions.length > 0) && (
                            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 flex items-start gap-2">
                                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                                <div className="text-xs text-amber-300 space-y-1">
                                    {extracted.confirmationReasons.map((reason) => <div key={reason}>{reason}</div>)}
                                    {extracted.assumptions.map((assumption) => <div key={assumption}>Předpoklad: {assumption}</div>)}
                                </div>
                            </div>
                        )}

                        <div className="space-y-3">
                            {entries.map((entry, index) => (
                                <div key={entry.localId} className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-xs font-black text-slate-500 uppercase tracking-widest">
                                            Záznam {index + 1}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => removeEntry(entry.localId)}
                                            className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-all"
                                            title="Odebrat řádek"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Datum</label>
                                            <input
                                                type="date"
                                                value={entry.date}
                                                onChange={(e) => updateEntry(entry.localId, { date: e.target.value })}
                                                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-white focus:border-indigo-500 outline-none"
                                            />
                                        </div>

                                        <div className="space-y-1.5 md:col-span-2">
                                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Projekt</label>
                                            <ProjectPicker
                                                selectedProjectId={entry.project?.id ?? null}
                                                onSelect={(p) => updateEntry(entry.localId, { project: p })}
                                            />
                                        </div>

                                        <div className="space-y-1.5 md:col-span-2">
                                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Lidi</label>
                                            <input
                                                type="text"
                                                value={entry.people}
                                                onChange={(e) => updateEntry(entry.localId, { people: e.target.value })}
                                                placeholder="Martin, Sergej, Pracovník 1"
                                                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:border-indigo-500 outline-none"
                                            />
                                        </div>

                                        <div className="space-y-1.5">
                                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest">H / osoba</label>
                                            <input
                                                type="number"
                                                step="0.25"
                                                min="0"
                                                value={entry.hoursPerPerson ?? ''}
                                                onChange={(e) => updateEntry(entry.localId, { hoursPerPerson: parseHours(e.target.value) })}
                                                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-white focus:border-indigo-500 outline-none"
                                            />
                                        </div>

                                        <div className="space-y-1.5">
                                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Celkem h</label>
                                            <input
                                                type="number"
                                                step="0.25"
                                                min="0"
                                                value={entry.hours}
                                                onChange={(e) => updateEntry(entry.localId, { hours: parseHours(e.target.value), calculationNote: undefined })}
                                                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-white focus:border-indigo-500 outline-none"
                                            />
                                        </div>

                                        <div className="space-y-1.5 md:col-span-3">
                                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Popis</label>
                                            <input
                                                type="text"
                                                value={entry.description ?? ''}
                                                onChange={(e) => updateEntry(entry.localId, { description: e.target.value })}
                                                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-white focus:border-indigo-500 outline-none"
                                            />
                                        </div>

                                        <div className="md:col-span-5 text-xs text-slate-500">
                                            {entry.calculationNote || 'Bez výpočtu člověkohodin'}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="p-5 border-t border-slate-800 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onCancelled}
                            className="flex items-center gap-1.5 px-4 py-2 text-slate-400 hover:text-white text-xs font-black uppercase tracking-widest rounded-lg"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Zrušit
                        </button>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={saving || entries.length === 0}
                            className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-black uppercase tracking-widest rounded-lg"
                        >
                            <Save className="w-3.5 h-3.5" />
                            {saving ? 'Ukládám…' : `Uložit ${entries.length}×`}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
