import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Save, X, AlertTriangle, RotateCcw } from 'lucide-react';
import { db, type Project } from '../../db';
import { ProjectPicker } from './ProjectPicker';
import type { ExtractedWorkLog, ApplyResult } from '../../services/workLogExtractor';

interface WorkLogVoiceConfirmProps {
    extracted: ExtractedWorkLog;
    onConfirmed: (result: ApplyResult) => void;
    onCancelled: () => void;
}

export function WorkLogVoiceConfirm({ extracted, onConfirmed, onCancelled }: WorkLogVoiceConfirmProps) {
    const [date, setDate] = useState(extracted.date);
    const [project, setProject] = useState<Project | null>(null);
    const [people, setPeople] = useState(extracted.people);
    const [hours, setHours] = useState(String(extracted.hours));
    const [description, setDescription] = useState(extracted.description ?? '');
    const [saving, setSaving] = useState(false);

    const handleSave = async () => {
        const hoursNum = parseFloat(hours.replace(',', '.'));
        if (Number.isNaN(hoursNum) || hoursNum <= 0) return;
        if (!project) {
            alert('Vyberte projekt.');
            return;
        }

        setSaving(true);
        const now = Date.now();
        try {
            const id = await db.workLogs.add({
                date,
                projectId: project.id!,
                projectName: project.name,
                people: people.trim(),
                hours: hoursNum,
                description: description.trim() || undefined,
                source: 'voice',
                createdAt: now,
                updatedAt: now,
            });
            onConfirmed({
                ok: true,
                workLog: {
                    id: id as number,
                    date,
                    projectId: project.id!,
                    projectName: project.name,
                    people: people.trim(),
                    hours: hoursNum,
                    description: description.trim() || undefined,
                    source: 'voice',
                    createdAt: now,
                    updatedAt: now,
                },
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
                    className="w-full max-w-lg bg-slate-900 border-l border-white/5 shadow-2xl flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="p-5 border-b border-slate-800 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400">
                                <Mic className="w-5 h-5" />
                            </div>
                            <div>
                                <h3 className="text-lg font-black text-white uppercase tracking-tight">
                                    Ověř diktování
                                </h3>
                                <p className="text-xs text-slate-500 uppercase tracking-widest mt-1 font-bold">
                                    AI extrahovalo — zkontroluj a ulož
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

                    {/* Body */}
                    <div className="p-5 space-y-4 overflow-y-auto">
                        {!extracted.projectName && (
                            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 flex items-start gap-2">
                                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                                <span className="text-xs text-amber-400">
                                    AI nerozpoznalo projekt. Vyber ho ze seznamu nebo vytvoř nový.
                                </span>
                            </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Datum</label>
                                <input
                                    type="date"
                                    value={date}
                                    onChange={(e) => setDate(e.target.value)}
                                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:border-indigo-500 outline-none"
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Projekt</label>
                                <ProjectPicker
                                    selectedProjectId={project?.id ?? null}
                                    onSelect={(p) => setProject(p)}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Lidi</label>
                                <input
                                    type="text"
                                    value={people}
                                    onChange={(e) => setPeople(e.target.value)}
                                    placeholder="Pepa, Lukáš"
                                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:border-indigo-500 outline-none"
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Hodiny</label>
                                <input
                                    type="number"
                                    step="0.25"
                                    min="0"
                                    max="24"
                                    value={hours}
                                    onChange={(e) => setHours(e.target.value)}
                                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:border-indigo-500 outline-none"
                                />
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Popis</label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:border-indigo-500 outline-none resize-none"
                            />
                        </div>

                        <div className="bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2">
                            <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Původní diktát (parsováno z AI)</div>
                            <div className="text-xs text-slate-400 font-mono">
                                projectName: "{extracted.projectName}"<br />
                                people: "{extracted.people}"<br />
                                hours: {extracted.hours}<br />
                                description: "{extracted.description ?? ''}"<br />
                                date: {extracted.date}
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
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
                            disabled={saving}
                            className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-black uppercase tracking-widest rounded-lg"
                        >
                            <Save className="w-3.5 h-3.5" />
                            {saving ? 'Ukládám…' : 'Potvrdit a uložit'}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}