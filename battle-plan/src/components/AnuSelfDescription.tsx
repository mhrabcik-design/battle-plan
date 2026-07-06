import { Brain, Briefcase, Mic } from 'lucide-react';

const ROLES = [
    {
        title: 'Manažer',
        description: 'Z hlasu vytvářím úkoly, schůzky a myšlenky v Bitevním Plánu.',
        icon: Briefcase,
        tone: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/20',
    },
    {
        title: 'Zapisovatel',
        description: 'Z pracovního diktátu vytáhnu projekt, lidi, hodiny a popis práce.',
        icon: Mic,
        tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
    },
    {
        title: 'Partner',
        description: 'Sleduji Anu-BattlePlan složku na Drive a nabízím návrhy k přijetí, odložení nebo smazání.',
        icon: Brain,
        tone: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
    },
];

export function AnuSelfDescription() {
    return (
        <section className="p-4 bg-slate-800/30 rounded-2xl border border-slate-800/50">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-300">AI ARCHITEKT</p>
                    <h3 className="mt-1 text-sm font-black text-white uppercase tracking-widest">Jsem Anu</h3>
                </div>
                <div className="px-2 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-[10px] font-black text-indigo-300 uppercase tracking-widest">
                    Pomocník
                </div>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Pomáhám držet plán, zápisy práce a návrhy pohromadě. Neměním data sama od sebe; čekám na tvůj hlas, potvrzení návrhu nebo soubor v Drive složce.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {ROLES.map(({ title, description, icon: Icon, tone }) => (
                    <div key={title} className={`p-3 rounded-xl border ${tone}`}>
                        <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest">
                            <Icon className="w-4 h-4" />
                            {title}
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-slate-300">{description}</p>
                    </div>
                ))}
            </div>
        </section>
    );
}
