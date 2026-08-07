import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Plus, X } from 'lucide-react';
import { db, type Project, type ProjectColor } from '../../db';
import { createProject, type ProjectCatalogResult } from '../../services/projectCatalog';
import { PROJECT_COLOR_OPTIONS } from '../../utils/projectColors';

interface ProjectPickerProps {
    selectedProjectId: number | null;
    onSelect: (project: Project) => void;
}

function resultMessage(result: ProjectCatalogResult): string {
    if (result.outcome === 'duplicate') return `Projekt „${result.project.name}“ už existuje. Vyber ho ze seznamu.`;
    if (result.outcome === 'conflict') return 'Existuje více starších projektů se stejným názvem. Použij správu projektů.';
    if (result.outcome === 'validation') return result.message;
    return 'Projekt se nepodařilo založit.';
}

export function ProjectPicker({ selectedProjectId, onSelect }: ProjectPickerProps) {
    const [open, setOpen] = useState(false);
    const [showNew, setShowNew] = useState(false);
    const [newName, setNewName] = useState('');
    const [newColor, setNewColor] = useState<ProjectColor>('indigo');
    const [message, setMessage] = useState<string | null>(null);
    const [pendingRestore, setPendingRestore] = useState<Project | null>(null);
    const [busy, setBusy] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const projects = useLiveQuery(async () => {
        const all = await db.projects.toArray();
        return all.filter((project) => project.isActive).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    }, []) ?? [];

    useEffect(() => {
        if (!open) return;
        const onClickOutside = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onClickOutside);
        return () => document.removeEventListener('mousedown', onClickOutside);
    }, [open]);

    const selected = projects.find((project) => project.id === selectedProjectId) ?? null;

    const resetCreate = () => {
        setNewName('');
        setNewColor('indigo');
        setShowNew(false);
        setPendingRestore(null);
        setMessage(null);
    };

    const handleCreate = async (confirmRestore = false) => {
        if (!newName.trim()) return;
        setBusy(true);
        setMessage(null);
        try {
            const result = await createProject({
                name: newName,
                color: newColor,
                source: 'user',
                confirmRestore,
            });
            if (result.outcome === 'archived-match') {
                setPendingRestore(result.project);
                setMessage(`Projekt „${result.project.name}“ je archivovaný.`);
                return;
            }
            if (result.outcome === 'created' || result.outcome === 'restored') {
                onSelect(result.project);
                resetCreate();
                setOpen(false);
                return;
            }
            setMessage(resultMessage(result));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div ref={ref} className="relative w-full">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-left transition-all hover:border-slate-700"
            >
                {selected ? (
                    <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-3 w-3 shrink-0 rounded-full ${PROJECT_COLOR_OPTIONS.find((color) => color.value === selected.color)?.bg.split(' ')[0]}`} />
                        <span className="truncate text-sm font-bold text-white">{selected.name}</span>
                    </span>
                ) : <span className="text-sm font-bold uppercase tracking-widest text-slate-500">— Vyberte projekt —</span>}
                <span className="text-xs text-slate-500">▼</span>
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="absolute left-0 right-0 z-50 mt-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl"
                    >
                        {!showNew ? (
                            <div className="custom-scrollbar max-h-64 overflow-y-auto" role="listbox" aria-label="Aktivní projekty">
                                {projects.length === 0 ? (
                                    <div className="p-4 text-center text-xs uppercase tracking-widest text-slate-500">Žádné aktivní projekty</div>
                                ) : projects.map((project) => (
                                    <button
                                        key={project.id}
                                        type="button"
                                        role="option"
                                        aria-selected={project.id === selectedProjectId}
                                        onClick={() => { onSelect(project); setOpen(false); }}
                                        className={`flex w-full items-center gap-2 px-4 py-3 text-left transition-all hover:bg-slate-800/60 ${project.id === selectedProjectId ? 'bg-indigo-600/10' : ''}`}
                                    >
                                        <span className={`h-3 w-3 shrink-0 rounded-full ${PROJECT_COLOR_OPTIONS.find((color) => color.value === project.color)?.bg.split(' ')[0]}`} />
                                        <span className="min-w-0 flex-1 truncate text-sm text-white">{project.name}</span>
                                        {project.id === selectedProjectId && <Check className="h-3.5 w-3.5 text-indigo-400" />}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => { setShowNew(true); setMessage(null); }}
                                    className="flex w-full items-center gap-2 border-t border-slate-800 px-4 py-3 text-indigo-400 transition-all hover:bg-slate-800/40"
                                >
                                    <Plus className="h-4 w-4" />
                                    <span className="text-sm font-black uppercase tracking-widest">Nový projekt</span>
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-3 p-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-black uppercase tracking-widest text-slate-400">Nový projekt</span>
                                    <button type="button" aria-label="Zavřít založení projektu" onClick={resetCreate} className="text-slate-500 hover:text-white"><X className="h-4 w-4" /></button>
                                </div>
                                <label>
                                    <span className="sr-only">Název nového projektu</span>
                                    <input
                                        value={newName}
                                        onChange={(event) => { setNewName(event.target.value); setPendingRestore(null); setMessage(null); }}
                                        onKeyDown={(event) => { if (event.key === 'Enter') void handleCreate(false); }}
                                        placeholder="Název projektu (např. KB Plaza)"
                                        className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-600 focus:border-indigo-500"
                                        autoFocus
                                    />
                                </label>
                                {message && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{message}</div>}
                                <fieldset className="space-y-1.5">
                                    <legend className="text-xs font-black uppercase tracking-widest text-slate-500">Barva</legend>
                                    <div className="flex gap-2">
                                        {PROJECT_COLOR_OPTIONS.map((color) => (
                                            <button
                                                key={color.value}
                                                type="button"
                                                onClick={() => setNewColor(color.value)}
                                                aria-label={`Barva ${color.label}`}
                                                aria-pressed={newColor === color.value}
                                                className={`h-9 w-9 rounded-lg border-2 transition-all ${color.bg} ${newColor === color.value ? `scale-110 ring-2 ${color.ring}` : 'opacity-60 hover:opacity-100'}`}
                                            />
                                        ))}
                                    </div>
                                </fieldset>
                                {pendingRestore ? (
                                    <button type="button" onClick={() => void handleCreate(true)} disabled={busy} className="w-full rounded-lg bg-amber-500/20 py-2 text-sm font-black uppercase tracking-widest text-amber-200 hover:bg-amber-500/30 disabled:opacity-50">Obnovit původní projekt</button>
                                ) : (
                                    <button type="button" onClick={() => void handleCreate(false)} disabled={!newName.trim() || busy} className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-black uppercase tracking-widest text-white hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600">Vytvořit projekt</button>
                                )}
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
