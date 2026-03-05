import React from 'react';
import { motion } from 'framer-motion';
import { X, Save, CloudUpload, CloudDownload } from 'lucide-react';
import { googleService } from '../services/googleService';
import type { GoogleAuthStatus } from '../types';

interface SettingsModalProps {
    apiKey: string;
    setApiKey: (val: string) => void;
    selectedModel: string;
    setSelectedModel: (val: string) => void;
    availableModels: string[];
    uiScale: number;
    setUiScale: (val: number) => void;
    googleAuth: GoogleAuthStatus;
    handleBackupToDrive: () => Promise<boolean | undefined>;
    handleRestoreFromDrive: () => Promise<void>;
    isSyncing: boolean;
    lastSync: string | null;
    saveSettings: () => Promise<void>;
    setShowSettings: (val: boolean) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    apiKey,
    setApiKey,
    selectedModel,
    setSelectedModel,
    availableModels,
    uiScale,
    setUiScale,
    googleAuth,
    handleBackupToDrive,
    handleRestoreFromDrive,
    isSyncing,
    lastSync,
    saveSettings,
    setShowSettings
}) => {
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-slate-950/95 backdrop-blur-md">
            <motion.div
                initial={{ y: 50, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 50, opacity: 0 }}
                className="glass-card w-full max-w-sm p-8 space-y-6"
            >
                <div className="flex justify-between items-center">
                    <h2 className="text-2xl font-display font-bold text-white">Nastavení AI</h2>
                    <button onClick={() => setShowSettings(false)} className="text-slate-500 hover:text-white transition-colors">
                        <X />
                    </button>
                </div>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Gemini API Klíč</label>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-4 text-white text-sm focus:border-indigo-500/50 outline-none transition-all"
                            placeholder="Vložte svůj klíč..."
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Model Inteligenty</label>
                        <select
                            value={selectedModel}
                            onChange={(e) => setSelectedModel(e.target.value)}
                            className="w-full bg-slate-900 border border-white/10 rounded-2xl px-4 py-4 text-white text-sm focus:border-indigo-500/50 outline-none cursor-pointer"
                        >
                            {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                    </div>

                    <div className="pt-4 border-t border-white/5 space-y-3">
                        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">Vzhled a Čitelnost</h3>
                        <div className="p-4 bg-white/5 rounded-2xl border border-white/10 space-y-4">
                            <div className="flex justify-between items-center text-xs font-bold text-slate-400 uppercase">
                                <span>Velikost písma</span>
                                <span className="text-white px-2 py-0.5 bg-indigo-500/20 rounded-md border border-indigo-500/30">{uiScale}px</span>
                            </div>
                            <input
                                type="range"
                                min="12"
                                max="24"
                                step="1"
                                value={uiScale}
                                onChange={(e) => setUiScale(Number(e.target.value))}
                                className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                            />
                            <div className="flex justify-between text-xs text-slate-600 font-bold uppercase">
                                <span>Malé</span>
                                <span>Normální (16)</span>
                                <span>Velké</span>
                            </div>
                        </div>
                    </div>

                    <div className="pt-4 border-t border-white/5 space-y-3">
                        <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Cloud Sync</label>
                        {googleAuth.isSignedIn ? (
                            <div className="space-y-3">
                                <div className="flex items-center justify-between p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
                                    <span className="text-xs text-emerald-400 font-bold uppercase tracking-widest">Google Připojen</span>
                                    <button onClick={() => googleService.signOut()} className="text-[10px] text-slate-500 hover:text-red-400 uppercase underline transition-colors">Odpojit</button>
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={handleBackupToDrive}
                                        disabled={isSyncing}
                                        className="flex flex-col items-center justify-center p-4 bg-indigo-600/10 border border-indigo-500/20 rounded-2xl text-indigo-300 transition-all hover:bg-indigo-600/20 disabled:opacity-50"
                                    >
                                        <CloudUpload className={`w-5 h-5 mb-1 ${isSyncing ? 'animate-bounce' : ''}`} />
                                        <span className="text-[10px] font-black uppercase tracking-widest">Zálohovat</span>
                                    </button>
                                    <button
                                        onClick={handleRestoreFromDrive}
                                        disabled={isSyncing}
                                        className="flex flex-col items-center justify-center p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl text-blue-300 transition-all hover:bg-blue-500/20 disabled:opacity-50"
                                    >
                                        <CloudDownload className="w-5 h-5 mb-1" />
                                        <span className="text-[10px] font-black uppercase tracking-widest">Obnovit</span>
                                    </button>
                                </div>

                                {lastSync && (
                                    <p className="text-center text-[10px] text-slate-600 font-black uppercase tracking-widest">
                                        Poslední synchronizace: {lastSync}
                                    </p>
                                )}
                            </div>
                        ) : (
                            <button
                                onClick={() => googleService.signIn()}
                                className="w-full py-4 bg-white hover:bg-slate-200 text-slate-900 rounded-2xl text-xs font-black uppercase flex items-center justify-center gap-2 transition-all active:scale-95"
                            >
                                Google Přihlášení
                            </button>
                        )}
                    </div>
                </div>

                <button
                    onClick={saveSettings}
                    className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 transition-all active:scale-95 rounded-2xl text-white font-black uppercase text-xs flex items-center justify-center gap-2 shadow-xl shadow-indigo-600/20"
                >
                    <Save className="w-4 h-4" />
                    Uložit vše
                </button>
            </motion.div>
        </div>
    );
};
