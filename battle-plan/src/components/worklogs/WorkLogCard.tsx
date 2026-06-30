import { useState } from 'react';
import { Trash2, Edit3, Save, X } from 'lucide-react';
import { db, type WorkLog, type Project } from '../../db';
import { ProjectPicker } from './ProjectPicker';
import { hasExplainedPersonHours } from '../../utils/workLogBatch';

interface WorkLogCardProps {
    log: WorkLog;
    onDeleted?: (id: number) => void;
    onUpdated?: (log: WorkLog) => void;
}

const COLOR_DOT: Record<string, string> = {
    slate: 'bg-slate-400',
    indigo: 'bg-indigo-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
};

export function WorkLogCard({ log, onDeleted, onUpdated }: WorkLogCardProps) {
    const [editing, setEditing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // Edit state
    const [date, setDate] = useState(log.date);
    const [project, setProject] = useState<Project | null>(null);
    const [people, setPeople] = useState(log.people);
    const [hours, setHours] = useState(String(log.hours));
    const [description, setDescription] = useState(log.description ?? '');

    const handleDelete = async () => {
        if (log.id == null) return;
        await db.workLogs.delete(log.id);
        onDeleted?.(log.id);
    };

    const handleSave = async () => {
        if (log.id == null) return;
        const hoursNum = parseFloat(hours.replace(',', '.'));
        if (Number.isNaN(hoursNum) || hoursNum <= 0) return;
        if (!hasExplainedPersonHours(hoursNum, log.peopleCount, log.hoursPerPerson)) {
            alert('Hodiny nad 24 jsou povolené jen u záznamů s výpočtem člověkohodin.');
            return;
        }

        // Načti projekt pokud ho máme
        let proj = project;
        if (!proj) {
            const stored = await db.projects.get(log.projectId);
            if (stored) proj = stored;
        }

        const updates: Partial<WorkLog> = {
            date,
            people: people.trim(),
            hours: hoursNum,
            description: description.trim() || undefined,
            updatedAt: Date.now(),
        };
        if (proj && proj.id !== log.projectId) {
            updates.projectId = proj.id!;
            updates.projectName = proj.name;
        }
        await db.workLogs.update(log.id, updates);
        setEditing(false);
        onUpdated?.({ ...log, ...updates });
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
                            onChange={(e) => setPeople(e.target.value)}
                            placeholder="Kdo byl"
                            className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white"
                        />
                        <input
                            type="number"
                            step="0.25"
                            min="0"
                            value={hours}
                            onChange={(e) => setHours(e.target.value)}
                            placeholder="Hodiny"
                            className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Projekt</label>
                        <ProjectPicker
                            selectedProjectId={project?.id ?? log.projectId}
                            onSelect={(p) => setProject(p)}
                        />
                    </div>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={2}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white resize-none"
                    />
                    <div className="flex justify-end gap-2">
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
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black uppercase tracking-widest rounded-lg"
                        >
                            <Save className="w-3.5 h-3.5" />
                            Uložit
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${COLOR_DOT['slate']}`} />
                            <span className="text-xs font-black text-white uppercase tracking-tight truncate">
                                {log.projectName}
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
                            onClick={() => setEditing(true)}
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
