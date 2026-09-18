import { motion } from 'framer-motion';
import { CheckCircle2, Settings, FileText } from 'lucide-react';
import type { ViewMode } from '../types';
import type { SyncVisualState } from '../types';
import { syncIconFor } from './syncIcon';

interface SidebarProps {
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    isAiActive: boolean;
    navItems: Array<{ id: string; label: string; icon: React.ElementType }>;
    setShowSettings: (show: boolean) => void;
    isProcessing: boolean;
    suggestionsBadge: number;
    appVersion: string;
    syncState?: SyncVisualState;
}

export function Sidebar({
    viewMode,
    setViewMode,
    isAiActive,
    navItems,
    setShowSettings,
    isProcessing,
    suggestionsBadge,
    appVersion,
    syncState = 'ok',
}: SidebarProps) {
    const { Icon: SyncIcon, tone: syncTone, spin: syncSpin } = syncIconFor(syncState);
    return (
        <aside className="app-sidebar theme-surface hidden md:flex flex-col border-r border-white/5 shrink-0 relative z-[60]">
            <div className="px-5 py-6 flex flex-col items-start gap-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/20">
                        <CheckCircle2 className="w-5 h-5 text-on-accent" />
                    </div>
                    <span className="text-base font-semibold tracking-tight text-white leading-none">Bitevní Plán</span>
                </div>
                <span className="text-xs text-slate-500 ml-10">Prostor pro soustředění</span>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-5 space-y-7">
                <nav aria-label="Hlavní navigace" className="space-y-1">
                    <h3 className="sidebar-section-label">Pracovní prostor</h3>
                    {navItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = viewMode === item.id;
                        const showBadge = item.id === 'suggestions' && suggestionsBadge > 0;
                        return (
                            <button
                                key={item.id}
                                onClick={() => setViewMode(item.id as ViewMode)}
                                aria-current={isActive ? 'page' : undefined}
                                className={`sidebar-link w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-[background-color,color,box-shadow] duration-150 group ${isActive ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'}`}
                            >
                                <Icon className={`w-4 h-4 ${isActive ? 'scale-100' : 'group-hover:scale-110'} transition-transform`} />
                                <span>{item.label}</span>
                                {showBadge && (
                                    <span className="ml-auto px-2 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-black tracking-wide shadow-lg shadow-red-500/30">
                                        {suggestionsBadge}
                                    </span>
                                )}
                                {isActive && !showBadge && (
                                    <motion.div layoutId="active-indicator" className="ml-auto w-1 h-4 bg-white/20 rounded-full" />
                                )}
                            </button>
                        );
                    })}
                </nav>

                <div className="space-y-4">
                    <h3 className="sidebar-section-label">Nástroje</h3>
                    <div className="space-y-1">
                        <div className="mx-2 flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5 shadow-inner">
                            <div className={`w-2 h-2 rounded-full ${isAiActive ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-slate-700'}`} />
                            <div className="flex flex-col">
                                <span className="text-xs font-semibold text-white leading-none">Hlasový asistent</span>
                                <span className={`mt-1 text-xs ${isAiActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                                    {isAiActive ? 'Připravený k diktování' : 'Nastavte připojení AI'}
                                </span>
                            </div>
                        </div>

                        <button
                            onClick={() => setShowSettings(true)}
                            className="sidebar-link w-full flex items-center gap-3 px-3 py-3 hover:bg-white/5 text-slate-400 hover:text-white rounded-xl transition-[background-color,color]"
                        >
                            <Settings className={`w-4 h-4 ${isProcessing ? 'animate-spin' : ''}`} />
                            Nastavení
                            <SyncIcon
                                aria-hidden="true"
                                className={`ml-auto w-3.5 h-3.5 ${syncTone} ${syncSpin ? 'animate-spin' : ''}`}
                            />
                        </button>

                        <button
                            onClick={() => setViewMode('debug')}
                            aria-current={viewMode === 'debug' ? 'page' : undefined}
                            className={`sidebar-link w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-[background-color,color] ${viewMode === 'debug' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            <FileText className="w-4 h-4" />
                            Diagnostika
                        </button>
                    </div>
                </div>
                <div className="sidebar-shortcuts" aria-label="Klávesové zkratky">
                    <p><span>Nový záznam</span><kbd>N</kbd></p>
                    <p><span>Hledat</span><kbd>Ctrl / ⌘ K</kbd></p>
                    <p><span>Příkazy Anu</span><kbd>/</kbd></p>
                </div>
            </div>

            <div className="p-4 border-t border-slate-800 bg-slate-900/50">
                <div className="flex items-center gap-3 px-2">
                    <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-black text-sm text-indigo-400 shadow-inner">MB</div>
                    <div className="flex flex-col">
                        <span className="text-sm font-bold text-white leading-none">Martin H.</span>
                        <span className="text-xs text-slate-500 mt-1">Verze {appVersion}</span>
                    </div>
                </div>
            </div>
        </aside >
    );
}
