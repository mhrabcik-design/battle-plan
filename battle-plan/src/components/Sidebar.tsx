import { motion } from 'framer-motion';
import { CheckCircle2, CloudUpload, Settings, FileText } from 'lucide-react';
import type { ViewMode, GoogleAuthStatus } from '../types';

interface SidebarProps {
    viewMode: ViewMode;
    setViewMode: (mode: any) => void;
    isAiActive: boolean;
    googleAuth: GoogleAuthStatus;
    handleBackupToDrive: () => Promise<boolean | undefined>;
    isSyncing: boolean;
    navItems: Array<{ id: string; label: string; icon: any }>;
    setShowSettings: (show: boolean) => void;
    isProcessing: boolean;
}

export function Sidebar({
    viewMode,
    setViewMode,
    isAiActive,
    googleAuth,
    handleBackupToDrive,
    isSyncing,
    navItems,
    setShowSettings,
    isProcessing
}: SidebarProps) {
    return (
        <aside className="hidden md:flex flex-col w-64 border-r border-slate-800 bg-slate-900 shadow-xl shrink-0 relative z-[60]">
            <div className="p-6 flex flex-col items-start gap-1 border-b border-slate-800 bg-slate-900/50">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/20">
                        <CheckCircle2 className="w-5 h-5 text-white" />
                    </div>
                    <span className="text-base font-black uppercase tracking-tight text-white leading-none">Bitevní Plán</span>
                </div>
                <span className="text-sm text-slate-500 font-bold tracking-widest uppercase ml-10 opacity-70">Desktop Suite v4.0.0</span>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-6">
                <nav className="space-y-0.5">
                    <h3 className="px-4 text-sm font-black text-slate-600 uppercase tracking-[0.2em] mb-3">Nástroje</h3>
                    {navItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = viewMode === item.id;
                        return (
                            <button
                                key={item.id}
                                onClick={() => setViewMode(item.id as ViewMode)}
                                className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-150 group ${isActive ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'}`}
                            >
                                <Icon className={`w-4 h-4 ${isActive ? 'scale-100' : 'group-hover:scale-110'} transition-transform`} />
                                <span className="text-xs font-bold tracking-tight">{item.label}</span>
                                {isActive && (
                                    <motion.div layoutId="active-indicator" className="ml-auto w-1 h-4 bg-white/20 rounded-full" />
                                )}
                            </button>
                        );
                    })}
                </nav>

                <div className="space-y-4">
                    <h3 className="px-4 text-sm font-black text-slate-600 uppercase tracking-[0.2em]">Systém</h3>
                    <div className="space-y-1">
                        <div className="mx-2 flex items-center gap-3 p-3 rounded-xl bg-slate-800/30 border border-slate-800/50">
                            <div className={`w-2 h-2 rounded-full ${isAiActive ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-slate-700'}`} />
                            <div className="flex flex-col">
                                <span className="text-sm font-black text-white uppercase tracking-wider leading-none">AI ARCHITEKT</span>
                                <span className={`text-xs font-bold ${isAiActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                                    {isAiActive ? 'ONLINE' : 'OFFLINE'}
                                </span>
                            </div>
                        </div>

                        {googleAuth.isSignedIn && (
                            <button
                                onClick={handleBackupToDrive}
                                disabled={isSyncing}
                                className="mx-2 w-[calc(100%-1rem)] flex items-center gap-3 px-4 py-3 hover:bg-emerald-500/10 text-emerald-500 rounded-xl transition-all font-black uppercase text-sm tracking-widest border border-emerald-500/10"
                            >
                                <CloudUpload className={`w-4 h-4 ${isSyncing ? 'animate-bounce' : ''}`} />
                                {isSyncing ? 'Synchronizace...' : 'Zálohovat Disk'}
                            </button>
                        )}

                        <button
                            onClick={() => setShowSettings(true)}
                            className="mx-2 w-[calc(100%-1rem)] flex items-center gap-3 px-4 py-3 hover:bg-white/5 text-slate-400 hover:text-white rounded-xl transition-all font-bold uppercase text-sm tracking-widest"
                        >
                            <Settings className={`w-4 h-4 ${isProcessing ? 'animate-spin' : ''}`} />
                            Konfigurace
                        </button>

                        <button
                            onClick={() => setViewMode('debug' as any)}
                            className={`mx-2 w-[calc(100%-1rem)] flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-bold uppercase text-sm tracking-widest ${viewMode === ('debug' as any) ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                        >
                            <FileText className="w-4 h-4" />
                            Diagnostika
                        </button>
                    </div>
                </div>
            </div>

            <div className="p-4 border-t border-slate-800 bg-slate-900/50">
                <div className="flex items-center gap-3 px-2">
                    <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-black text-sm text-indigo-400 shadow-inner">MB</div>
                    <div className="flex flex-col">
                        <span className="text-sm font-bold text-white leading-none">Martin H.</span>
                        <span className="text-sm text-slate-500">Professional</span>
                    </div>
                </div>
            </div>
        </aside>
    );
}
