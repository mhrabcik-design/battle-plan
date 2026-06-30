import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X, Check } from 'lucide-react';
import { db, type Project, type ProjectColor } from '../../db';

interface ProjectPickerProps {
    selectedProjectId: number | null;
    onSelect: (project: Project) => void;
}

const COLOR_PRESETS: { value: ProjectColor; label: string; bg: string; ring: string }[] = [
    { value: 'slate', label: 'Šedá', bg: 'bg-slate-500/30 border-slate-400/40', ring: 'ring-slate-400' },
    { value: 'indigo', label: 'Indigo', bg: 'bg-indigo-500/30 border-indigo-400/40', ring: 'ring-indigo-400' },
    { value: 'emerald', label: 'Emerald', bg: 'bg-emerald-500/30 border-emerald-400/40', ring: 'ring-emerald-400' },
    { value: 'amber', label: 'Amber', bg: 'bg-amber-500/30 border-amber-400/40', ring: 'ring-amber-400' },
    { value: 'rose', label: 'Rose', bg: 'bg-rose-500/30 border-rose-400/40', ring: 'ring-rose-400' },
];

export function ProjectPicker({ selectedProjectId, onSelect }: ProjectPickerProps) {
    const [open, setOpen] = useState(false);
    const [projects, setProjects] = useState<Project[]>([]);
    const [showNew, setShowNew] = useState(false);
    const [newName, setNewName] = useState('');
    const [newColor, setNewColor] = useState<ProjectColor>('indigo');
    const [dupWarning, setDupWarning] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);

    const loadProjects = async () => {
        // Dexie neumí indexovat boolean — ruční filtr
        const all = await db.projects.toArray();
        setProjects(all.filter((p) => p.isActive).sort((a, b) => a.name.localeCompare(b.name, 'cs')));
    };

    useEffect(() => {
        queueMicrotask(() => {
            loadProjects();
        });
    }, []);

    // Zavři dropdown při kliknutí mimo
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                setShowNew(false);
                setDupWarning(null);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [open]);

    const selected = projects.find((p) => p.id === selectedProjectId) ?? null;

    const handleCreate = async () => {
        const trimmed = newName.trim();
        if (!trimmed) return;

        // Case-insensitive duplicate check
        const dup = projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
        if (dup) {
            setDupWarning(`Projekt „${dup.name}" už existuje. Vyber ho ze seznamu nebo zadej jiný název.`);
            return;
        }

        const now = Date.now();
        const newId = await db.projects.add({
            name: trimmed,
            color: newColor,
            isActive: true,
            createdAt: now,
            updatedAt: now,
        });
        const created: Project = {
            id: newId as number,
            name: trimmed,
            color: newColor,
            isActive: true,
            createdAt: now,
            updatedAt: now,
        };
        await loadProjects();
        onSelect(created);
        setNewName('');
        setNewColor('indigo');
        setShowNew(false);
        setOpen(false);
        setDupWarning(null);
    };

    return (
        <div ref={ref} className="relative w-full">
            {/* Trigger */}
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-slate-900/60 border border-slate-800 rounded-xl text-left hover:border-slate-700 transition-all"
            >
                {selected ? (
                    <span className="flex items-center gap-2 min-w-0">
                        <span className={`w-3 h-3 rounded-full shrink-0 ${COLOR_PRESETS.find((c) => c.value === selected.color)?.bg.split(' ')[0]}`} />
                        <span className="text-sm font-bold text-white truncate">{selected.name}</span>
                    </span>
                ) : (
                    <span className="text-sm font-bold text-slate-500 uppercase tracking-widest">— Vyberte projekt —</span>
                )}
                <span className="text-slate-500 text-xs">▼</span>
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="absolute z-50 left-0 right-0 mt-2 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden"
                    >
                        {!showNew ? (
                            <div className="max-h-64 overflow-y-auto custom-scrollbar">
                                {projects.length === 0 ? (
                                    <div className="p-4 text-xs text-slate-500 uppercase tracking-widest text-center">
                                        Žádné projekty
                                    </div>
                                ) : (
                                    projects.map((p) => (
                                        <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => {
                                                onSelect(p);
                                                setOpen(false);
                                            }}
                                            className={`w-full flex items-center gap-2 px-4 py-2.5 hover:bg-slate-800/60 transition-all ${
                                                p.id === selectedProjectId ? 'bg-indigo-600/10' : ''
                                            }`}
                                        >
                                            <span className={`w-3 h-3 rounded-full shrink-0 ${COLOR_PRESETS.find((c) => c.value === p.color)?.bg.split(' ')[0]}`} />
                                            <span className="text-sm text-white truncate flex-1 text-left">{p.name}</span>
                                            {p.id === selectedProjectId && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                                        </button>
                                    ))
                                )}
                                <button
                                    type="button"
                                    onClick={() => setShowNew(true)}
                                    className="w-full flex items-center gap-2 px-4 py-3 border-t border-slate-800 text-indigo-400 hover:bg-slate-800/40 transition-all"
                                >
                                    <Plus className="w-4 h-4" />
                                    <span className="text-sm font-black uppercase tracking-widest">+ Nový projekt</span>
                                </button>
                            </div>
                        ) : (
                            <div className="p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Nový projekt</span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowNew(false);
                                            setDupWarning(null);
                                            setNewName('');
                                        }}
                                        className="text-slate-500 hover:text-white"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    value={newName}
                                    onChange={(e) => {
                                        setNewName(e.target.value);
                                        setDupWarning(null);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleCreate();
                                    }}
                                    placeholder="Název projektu (např. KB Plaza)"
                                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white placeholder-slate-600 focus:border-indigo-500 outline-none"
                                    autoFocus
                                />
                                {dupWarning && (
                                    <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                                        {dupWarning}
                                    </div>
                                )}
                                <div className="space-y-1.5">
                                    <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Barva</span>
                                    <div className="flex gap-2">
                                        {COLOR_PRESETS.map((c) => (
                                            <button
                                                key={c.value}
                                                type="button"
                                                onClick={() => setNewColor(c.value)}
                                                title={c.label}
                                                className={`w-9 h-9 rounded-lg border-2 transition-all ${c.bg} ${
                                                    newColor === c.value ? `ring-2 ${c.ring} scale-110` : 'opacity-60 hover:opacity-100'
                                                }`}
                                            />
                                        ))}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleCreate}
                                    disabled={!newName.trim()}
                                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-black uppercase tracking-widest rounded-lg transition-all"
                                >
                                    Vytvořit projekt
                                </button>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
