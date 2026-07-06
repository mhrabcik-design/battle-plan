import { Brain, Briefcase, Check, Mic } from 'lucide-react';

interface OnboardingCardProps {
    onDismiss: () => void;
}

const ROLES = [
    ['Manažer', 'Nadiktuj úkol, schůzku nebo nápad — Anu z toho vytvoří strukturovaný záznam.', Briefcase],
    ['Zapisovatel', 'Diktát práce převede na worklog: projekt, lidi, hodiny a popis.', Mic],
    ['Partner', 'Návrhy z Drive složky umí přijmout, zamítnout, odložit nebo smazat.', Brain],
] as const;

export function OnboardingCard({ onDismiss }: OnboardingCardProps) {
    return (
        <section className="mb-5 p-4 md:p-5 bg-indigo-950/30 border border-indigo-500/20 rounded-3xl shadow-2xl shadow-indigo-950/20">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div className="max-w-3xl">
                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-indigo-300">Nově: Anu v Bitevním Plánu</p>
                    <h2 className="mt-2 text-xl md:text-2xl font-black text-white uppercase tracking-tight">Hlas, práce a návrhy na jednom místě</h2>
                    <p className="mt-2 text-sm text-slate-300 leading-relaxed">
                        Anu je agent v aplikaci: poslouchá diktát, vytahuje pracovní záznamy a pomáhá zpracovat návrhy bez ručního přepisování.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black uppercase tracking-widest transition-all"
                >
                    <Check className="w-4 h-4" />
                    Rozumím
                </button>
            </div>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
                {ROLES.map(([title, text, Icon]) => (
                    <div key={title} className="p-3 rounded-2xl bg-slate-950/40 border border-white/5">
                        <div className="flex items-center gap-2 text-xs font-black text-white uppercase tracking-widest">
                            <Icon className="w-4 h-4 text-indigo-300" />
                            {title}
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-slate-400">{text}</p>
                    </div>
                ))}
            </div>
        </section>
    );
}
