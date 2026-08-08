import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Trash2, Edit3, Save, X } from 'lucide-react';
import { db, type WorkLog, type Project } from '../../db';
import { ProjectPicker } from './ProjectPicker';
import {
    countPeopleInText,
    derivePersonHourMetadata,
    getWorkLogRowIssues,
    parseDecimalHours,
} from '../../utils/workLogBatch';
import { normalizeProjectName } from '../../services/projectCatalog';
import {
    isMatchingActiveProject,
    ProjectUnavailableError,
    updateWorkLogWithProjectSelection,
    type WorkLogEditableChanges,
    type WorkLogProjectSelection,
} from '../../services/workLogPersistence';
import { getErrorMessage } from '../../utils/errors';
import { PROJECT_COLOR_DOT } from '../../utils/projectColors';
import {
    resolveWorkLogProjectDisplay,
    type WorkLogProjectIndex,
} from '../../utils/workLogProjectGrouping';

interface WorkLogCardProps {
    log: WorkLog;
    projectIndex: WorkLogProjectIndex;
    onDeleted?: (id: number) => void;
    onUpdated?: (log: WorkLog) => void;
}

export function WorkLogCard({ log, projectIndex, onDeleted, onUpdated }: WorkLogCardProps) {
    const [editing, setEditing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // Edit state
    const [date, setDate] = useState(log.date);
    const [project, setProject] = useState<Project | null>(null);
    const [people, setPeople] = useState(log.people);
    const [hours, setHours] = useState(String(log.hours));
    const [hoursPerPerson, setHoursPerPerson] = useState(log.hoursPerPerson == null ? '' : String(log.hoursPerPerson));
    const [description, setDescription] = useState(log.description ?? '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const projectDisplay = resolveWorkLogProjectDisplay(log, projectIndex);

    const selectedMatchesOriginal = project != null
        && project.id === log.projectId
        && normalizeProjectName(project.name) === normalizeProjectName(log.projectName);
    const assignmentChanged = project != null && !selectedMatchesOriginal;
    const currentSelection: WorkLogProjectSelection = project?.id == null
        ? { id: log.projectId, name: log.projectName }
        : { id: project.id, name: project.name };
    const activeSelection = useLiveQuery(async () => {
        if (!editing || currentSelection.id == null) return null;
        const stored = await db.projects.get(currentSelection.id);
        return isMatchingActiveProject(stored, currentSelection) ? stored : null;
    }, [editing, currentSelection.id, currentSelection.name]);

    const showPersonHourEditor = log.hours > 24 || log.hoursPerPerson != null || hoursPerPerson !== '';

    const startEditing = () => {
        setDate(log.date);
        setProject(null);
        setPeople(log.people);
        setHours(String(log.hours));
        setHoursPerPerson(log.hoursPerPerson == null ? '' : String(log.hoursPerPerson));
        setDescription(log.description ?? '');
        setError(null);
        setEditing(true);
    };

    const updatePeople = (value: string) => {
        setPeople(value);
        const metadata = derivePersonHourMetadata({
            people: value,
            hours: parseDecimalHours(hours),
            hoursPerPerson,
        });
        if (metadata.hoursPerPerson) {
            setHours(String(metadata.hours));
        }
    };

    const updateHoursPerPerson = (value: string) => {
        setHoursPerPerson(value);
        const metadata = derivePersonHourMetadata({
            people,
            hours: parseDecimalHours(hours),
            hoursPerPerson: value,
        });
        if (metadata.hoursPerPerson) {
            setHours(String(metadata.hours));
        }
    };

    const updateTotalHours = (value: string) => {
        setHours(value);
        setHoursPerPerson('');
    };

    const handleDelete = async () => {
        if (log.id == null) return;
        await db.workLogs.delete(log.id);
        onDeleted?.(log.id);
    };

    const handleSave = async () => {
        if (log.id == null) return;
        const hoursNum = parseDecimalHours(hours);
        const metadata = derivePersonHourMetadata({
            people,
            hours: hoursNum,
            hoursPerPerson,
        });
        const saveHours = metadata.hours;
        const issues = getWorkLogRowIssues({
            projectSelected: true,
            date,
            people,
            hours: saveHours,
            peopleCount: metadata.peopleCount,
            hoursPerPerson: metadata.hoursPerPerson,
            requirePeople: Boolean(metadata.hoursPerPerson) || saveHours > 24,
        });
        if (issues.length > 0) {
            alert(issues.join(' '));
            return;
        }

        const updates: WorkLogEditableChanges = {
            date,
            people: people.trim(),
            hours: saveHours,
            hoursPerPerson: metadata.hoursPerPerson,
            peopleCount: metadata.peopleCount,
            calculationNote: metadata.calculationNote,
            description: description.trim() || undefined,
            updatedAt: Date.now(),
        };
        setSaving(true);
        setError(null);
        try {
            const updated = await updateWorkLogWithProjectSelection({
                id: log.id,
                selectedProject: project?.id == null ? null : { id: project.id, name: project.name },
                changes: updates,
            });
            setEditing(false);
            onUpdated?.(updated);
        } catch (saveError) {
            setError(saveError instanceof ProjectUnavailableError
                ? 'Vybraný projekt už není aktivní. Historické přiřazení zůstalo beze změny.'
                : `Uložení selhalo: ${getErrorMessage(saveError)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition-all">
            {editing ? (
                <div className="space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                            className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white"
                        />
                        <input
                            type="text"
                            value={people}
                            onChange={(e) => updatePeople(e.target.value)}
                            placeholder="Kdo byl"
                            className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white"
                        />
                        <input
                            type="number"
                            step="0.25"
                            min="0"
                            value={hours}
                            onChange={(e) => updateTotalHours(e.target.value)}
                            placeholder="Hodiny"
                            className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white"
                        />
                    </div>
                    {showPersonHourEditor && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <input
                                type="number"
                                step="0.25"
                                min="0"
                                value={hoursPerPerson}
                                onChange={(e) => updateHoursPerPerson(e.target.value)}
                                placeholder="H / osoba"
                                className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white"
                            />
                            <div className="md:col-span-2 px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-500 uppercase tracking-widest">
                                {derivePersonHourMetadata({
                                    people,
                                    hours: parseDecimalHours(hours),
                                    hoursPerPerson,
                                }).calculationNote || (countPeopleInText(people) > 0 ? 'Bez výpočtu člověkohodin' : 'Doplň lidi pro výpočet')}
                            </div>
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Projekt</label>
                        <ProjectPicker
                            selectedProjectId={activeSelection?.id ?? null}
                            onSelect={(selected) => {
                                setProject(selected);
                                setError(null);
                            }}
                        />
                        {activeSelection === null && !assignmentChanged && (
                            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                                Ponecháno historické přiřazení: {log.projectName}
                            </div>
                        )}
                        {activeSelection === null && assignmentChanged && (
                            <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                                Vybraný projekt už není aktivní: {project.name}
                            </div>
                        )}
                    </div>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={2}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white resize-none"
                    />
                    <div className="flex justify-end gap-2">
                        {error && (
                            <div role="alert" className="mr-auto text-xs text-red-400">
                                {error}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => setEditing(false)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-slate-400 hover:text-white text-xs font-black uppercase tracking-widest"
                        >
                            <X className="w-3.5 h-3.5" />
                            Zrušit
                        </button>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={saving}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-black uppercase tracking-widest rounded-lg"
                        >
                            <Save className="w-3.5 h-3.5" />
                            {saving ? 'Ukládám…' : 'Uložit'}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${PROJECT_COLOR_DOT[projectDisplay.color]}`} />
                            <span className="text-xs font-black text-white uppercase tracking-tight truncate">
                                {projectDisplay.name}
                            </span>
                            <span className="text-xs text-slate-500 ml-auto whitespace-nowrap">
                                {new Date(log.date).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short' })}
                            </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                            <span className="text-slate-400">
                                <span className="text-white font-black">{log.hours}</span> h
                            </span>
                            {log.people && (
                                <span className="text-slate-400 truncate">· {log.people}</span>
                            )}
                            {log.source === 'voice' && (
                                <span className="text-indigo-400 uppercase tracking-widest text-[10px]">voice</span>
                            )}
                        </div>
                        {log.calculationNote && (
                            <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-widest">{log.calculationNote}</p>
                        )}
                        {log.description && (
                            <p className="text-xs text-slate-500 mt-2 line-clamp-2">{log.description}</p>
                        )}
                    </div>
                    <div className="flex flex-col gap-1">
                        <button
                            type="button"
                            onClick={startEditing}
                            className="p-1.5 text-slate-500 hover:text-indigo-400 transition-all"
                            title="Upravit"
                        >
                            <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirmDelete((c) => !c)}
                            className="p-1.5 text-slate-500 hover:text-red-400 transition-all"
                            title="Smazat"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            )}

            {confirmDelete && !editing && (
                <div className="mt-3 flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                    <span className="text-xs text-red-400 flex-1">Opravdu smazat?</span>
                    <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="text-xs text-slate-400 hover:text-white px-2"
                    >
                        Ne
                    </button>
                    <button
                        type="button"
                        onClick={handleDelete}
                        className="text-xs text-red-400 hover:text-red-300 font-black uppercase tracking-widest px-2"
                    >
                        Smazat
                    </button>
                </div>
            )}
        </div>
    );
}
