import type { ProjectColor } from '../db';

export const PROJECT_COLOR_OPTIONS = [
    { value: 'slate', label: 'Šedá', bg: 'bg-slate-500/30 border-slate-400/40', ring: 'ring-slate-400' },
    { value: 'indigo', label: 'Indigo', bg: 'bg-indigo-500/30 border-indigo-400/40', ring: 'ring-indigo-400' },
    { value: 'emerald', label: 'Smaragdová', bg: 'bg-emerald-500/30 border-emerald-400/40', ring: 'ring-emerald-400' },
    { value: 'amber', label: 'Jantarová', bg: 'bg-amber-500/30 border-amber-400/40', ring: 'ring-amber-400' },
    { value: 'rose', label: 'Růžová', bg: 'bg-rose-500/30 border-rose-400/40', ring: 'ring-rose-400' },
] as const satisfies readonly { value: ProjectColor; label: string; bg: string; ring: string }[];

export const PROJECT_COLOR_VALUES: readonly ProjectColor[] = PROJECT_COLOR_OPTIONS.map(({ value }) => value);

export const PROJECT_COLOR_DOT: Record<ProjectColor, string> = {
    slate: 'bg-slate-400',
    indigo: 'bg-indigo-400',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-rose-400',
};
