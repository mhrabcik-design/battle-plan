import { useState } from 'react';
import { Save, X, Plus } from 'lucide-react';
import { db, type WorkLog, type Project } from '../../db';
import { ProjectPicker } from './ProjectPicker';

interface WorkLogFormProps {
    onSaved?: (log: WorkLog) => void;
    onCancel?: () => void;
}

const todayIso = () => new Date().toISOString().split('T')[0];

export function WorkLogForm({ onSaved, onCancel }: WorkLogFormProps) {
    const [date, setDate] = useState(todayIso());
    const [project, setProject] = useState<Project | null>(null);
    const [people, setPeople] = useState('');
    const [hours, setHours] = useState('');
    const [description, setDescription] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSave = async () => {
        setError(null);

        if (!project) {
            setError('Vyberte projekt.');
            return;
        }
        const hoursNum = parseFloat(hours.replace(',', '.'));
        if (!hours || Number.isNaN(hoursNum) || hoursNum <= 0 || hoursNum > 24) {
            setError('Zadejte platný počet hodin (0–24).');
            return;
        }

        setSaving(true);
        try {
            const now = Date.now();
            const id = await db.workLogs.add({
                date,
                projectId: project.id!,
                projectName: project.name,
                people: people.trim(),
                hours: hoursNum,
                description: description.trim() || undefined,
                source: 'manual',
                createdAt: now,
                updatedAt: now,
            });
            const saved: WorkLog = {
                id: id as number,
                date,
                projectId: project.id!,
                projectName: project.name,
                people: people.trim(),
                hours: hoursNum,
                description: description.trim() || undefined,
                source: 'manual',
                createdAt: now,
                updatedAt: now,
            };
            onSaved?.(saved);
            // Reset (kromě data a projektu — typicky zůstávají)
            setPeople('');
            setHours('');
            setDescription('');
        } catch (e) {
            setError(`Uložení selhalo: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-black text-white uppercase tracking-widest flex items-center gap-2">
                    <Plus className="w-4 h-4 text-indigo-400" />
                    Nová činnost
                </h3>
                {onCancel && (
                    <button type="button" onClick={onCancel} className="text-slate-500 hover:text-white">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Datum */}
                <div className="space-y-1.5">
                    <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Datum</label>
                    <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        max={todayIso()}
                        className="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:border-indigo-500 outline-none"
                    />
                </div>

                {/* Projekt */}
                <div className="space-y-1.5">
                    <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Projekt</label>
                    <ProjectPicker
                        selectedProjectId={project?.id ?? null}
                        onSelect={(p) => setProject(p)}
                    />
                </div>

                {/* Lidi */}
                <div className="space-y-1.5">
                    <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Kdo byl na zakázce</label>
                    <input
                        type="text"
                        value={people}
                        onChange={(e) => setPeople(e.target.value)}
                        placeholder="Pepa, Lukáš"
                        className="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:border-indigo-500 outline-none"
                    />
                </div>

                {/* Hodiny */}
                <div className="space-y-1.5">
                    <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Hodiny</label>
                    <input
                        type="number"
                        inputMode="decimal"
                        step="0.25"
                        min="0"
                        max="24"
                        value={hours}
                        onChange={(e) => setHours(e.target.value)}
                        placeholder="8"
                        className="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:border-indigo-500 outline-none"
                    />
                </div>
            </div>

            {/* Popis */}
            <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Popis (volitelně)</label>
                <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Co se dělalo..."
                    rows={2}
                    className="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:border-indigo-500 outline-none resize-none"
                />
            </div>

            {error && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                    {error}
                </div>
            )}

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-black uppercase tracking-widest rounded-xl transition-all"
                >
                    <Save className="w-4 h-4" />
                    {saving ? 'Ukládám…' : 'Uložit činnost'}
                </button>
            </div>
        </div>
    );
}