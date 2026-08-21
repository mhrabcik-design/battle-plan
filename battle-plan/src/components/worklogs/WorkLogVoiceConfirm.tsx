import { useEffect, useMemo, useState } from 'react';
import { Mic, Save, X, AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { db, type Project, type WorkLog } from '../../db';
import { ProjectPicker } from './ProjectPicker';
import { findProjectByName, type ExtractedWorkLog, type ExtractedWorkLogBatch } from '../../services/workLogExtractor';
import { derivePersonHourMetadata, getWorkLogRowIssues, parseDecimalHours } from '../../utils/workLogBatch';
import { createWorkLogSyncId } from '../../utils/workLogSyncIdentity';
import { getErrorMessage } from '../../utils/errors';
import { OverlaySurface } from '../ui/OverlaySurface';
import {
    addWorkLogsWithActiveProjects,
    ProjectUnavailableError,
    type NewWorkLogDraft,
} from '../../services/workLogPersistence';

interface WorkLogVoiceConfirmProps {
    extracted: ExtractedWorkLogBatch;
    onConfirmed: (result: WorkLogVoiceConfirmResult) => void;
    onCancelled: () => void;
}

export type WorkLogVoiceConfirmResult = {
    workLog: WorkLog;
    workLogs: WorkLog[];
};

type EditableEntry = ExtractedWorkLog & {
    localId: string;
    project: Project | null;
};

const PROJECT_CATALOG_LOAD_ERROR = 'Katalog projektů se nepodařilo načíst. Návrhy můžete dál upravit; před uložením zkuste projekty vybrat ručně.';

export function WorkLogVoiceConfirm({ extracted, onConfirmed, onCancelled }: WorkLogVoiceConfirmProps) {
    const [entries, setEntries] = useState<EditableEntry[]>(
        extracted.entries.map((entry, index) => ({
            ...entry,
            localId: `${entry.date}-${index}-${entry.projectName}`,
            project: null,
        })),
    );
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [catalogLoadError, setCatalogLoadError] = useState<string | null>(null);

    const totalHours = useMemo(
        () => entries.reduce((sum, entry) => sum + parseDecimalHours(entry.hours), 0),
        [entries],
    );

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const projects = await db.projects.toArray();
                if (cancelled) return;
                setEntries((prev) =>
                    prev.map((entry) => {
                        if (entry.project || !entry.projectName) return entry;
                        const project = findProjectByName(entry.projectName, projects);
                        return project ? { ...entry, project } : entry;
                    }),
                );
            } catch {
                if (!cancelled) setCatalogLoadError(PROJECT_CATALOG_LOAD_ERROR);
            }
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
                Object.assign(next, derivePersonHourMetadata({
                    people: next.people,
                    hours: parseDecimalHours(next.hours),
                    hoursPerPerson: next.hoursPerPerson,
                }));
            }
            if ('hours' in updates) {
                next.hoursPerPerson = undefined;
                next.peopleCount = undefined;
                next.calculationNote = undefined;
            }
            return next;
        }));
    };

    const removeEntry = (localId: string) => {
        setEntries((prev) => prev.filter((entry) => entry.localId !== localId));
    };

    const handleSave = async () => {
        setSaveError(null);
        if (entries.length === 0) {
            alert('Není co uložit.');
            return;
        }

        const invalid = entries.find((entry) => getWorkLogRowIssues({
            projectSelected: Boolean(entry.project),
            date: entry.date,
            people: entry.people,
            hours: entry.hours,
            peopleCount: entry.peopleCount,
            hoursPerPerson: entry.hoursPerPerson,
        }).length > 0);
        if (invalid) {
            alert('Zkontrolujte neúplné řádky. U diktované práce musí být projekt, datum, lidi a platné hodiny.');
            return;
        }

        setSaving(true);
        const now = Date.now();
        const batchId = `voice-${now}`;
        try {
            const drafts: NewWorkLogDraft[] = entries.map((entry) => {
                const project = entry.project!;
                return {
                        syncId: createWorkLogSyncId(),
                        date: entry.date,
                        projectId: project.id!,
                        projectName: project.name,
                        people: entry.people.trim(),
                        hours: parseDecimalHours(entry.hours),
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
            });
            const saved = await addWorkLogsWithActiveProjects(drafts);

            onConfirmed({
                workLog: saved[0]!,
                workLogs: saved,
            });
        } catch (error) {
            setSaveError(error instanceof ProjectUnavailableError
                ? 'Některý vybraný projekt už není aktivní. Opravte projekt; žádný řádek nebyl uložen.'
                : `Uložení selhalo: ${getErrorMessage(error)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <OverlaySurface
            title="Ověřit diktování práce"
            onRequestClose={onCancelled}
            variant="sheet"
            className="flex h-full w-full max-w-5xl flex-col overflow-hidden border-l border-white/10 bg-slate-900 shadow-2xl"
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
                            className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-800/70 hover:text-white transition-[background-color,color]"
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
                        {catalogLoadError && (
                            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                                {catalogLoadError}
                            </div>
                        )}

                        <div className="space-y-3">
                            {entries.map((entry, index) => {
                                const rowIssues = getWorkLogRowIssues({
                                    projectSelected: Boolean(entry.project),
                                    date: entry.date,
                                    people: entry.people,
                                    hours: entry.hours,
                                    peopleCount: entry.peopleCount,
                                    hoursPerPerson: entry.hoursPerPerson,
                                });
                                return (
                                <div key={entry.localId} className={`bg-slate-950/50 border rounded-xl p-3 space-y-3 ${rowIssues.length > 0 ? 'border-amber-500/40' : 'border-slate-800'}`}>
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-xs font-black text-slate-500 uppercase tracking-widest">
                                            Záznam {index + 1}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => removeEntry(entry.localId)}
                                            className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
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
                                                onChange={(e) => updateEntry(entry.localId, { hoursPerPerson: e.target.value === '' ? undefined : parseDecimalHours(e.target.value) })}
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
                                                onChange={(e) => updateEntry(entry.localId, { hours: parseDecimalHours(e.target.value), hoursPerPerson: undefined, peopleCount: undefined, calculationNote: undefined })}
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
                                        {rowIssues.length > 0 && (
                                            <div className="md:col-span-5 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                                                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                                <span>{rowIssues.join(' ')}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )})}
                        </div>
                        {saveError && (
                            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                                {saveError}
                            </div>
                        )}
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
        </OverlaySurface>
    );
}
