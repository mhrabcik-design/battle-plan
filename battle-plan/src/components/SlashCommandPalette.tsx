import { useEffect, useState } from 'react';
import { Brain, Briefcase, FileText, Mic, X } from 'lucide-react';

interface SlashCommandPaletteProps {
    onOpenVoice: () => void;
    onOpenWorklogs: () => void;
    onOpenSuggestions: () => void;
    onOpenDiagnostics: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

export function SlashCommandPalette({ onOpenVoice, onOpenWorklogs, onOpenSuggestions, onOpenDiagnostics }: SlashCommandPaletteProps) {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                return;
            }
            if (event.key !== '/' || isTypingTarget(event.target)) return;
            event.preventDefault();
            setOpen(true);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    if (!open) return null;

    const items = [
        { label: 'Manažer', description: 'Otevřít hlas pro nový task, schůzku nebo nápad.', icon: Briefcase, action: onOpenVoice },
        { label: 'Zapisovatel', description: 'Přejít na práci a diktovat worklog.', icon: Mic, action: onOpenWorklogs },
        { label: 'Partner', description: 'Otevřít návrhy od Anu.', icon: Brain, action: onOpenSuggestions },
        { label: 'Diagnostika', description: 'Ukázat stav syncu a popis schopností Anu.', icon: FileText, action: onOpenDiagnostics },
    ];

    return (
        <div className="fixed inset-0 z-[220] flex items-start justify-center pt-24 px-4 bg-slate-950/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Anu příkazy">
            <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-950 shadow-2xl shadow-black/50 overflow-hidden">
                <div className="flex items-center justify-between gap-3 p-4 border-b border-white/5">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-indigo-300">/ příkazy</p>
                        <h2 className="text-lg font-black text-white uppercase tracking-tight">Co umí Anu?</h2>
                    </div>
                    <button type="button" onClick={() => setOpen(false)} className="p-2 rounded-xl bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800" aria-label="Zavřít příkazy">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="p-2">
                    {items.map(({ label, description, icon: Icon, action }) => (
                        <button
                            key={label}
                            type="button"
                            onClick={() => { setOpen(false); action(); }}
                            className="w-full flex items-start gap-3 p-3 rounded-2xl text-left hover:bg-slate-900 transition-colors"
                        >
                            <span className="p-2 rounded-xl bg-indigo-500/10 text-indigo-300"><Icon className="w-4 h-4" /></span>
                            <span>
                                <span className="block text-sm font-black text-white uppercase tracking-widest">{label}</span>
                                <span className="block mt-1 text-xs text-slate-400 leading-relaxed">{description}</span>
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
