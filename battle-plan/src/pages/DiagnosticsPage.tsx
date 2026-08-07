import { AnuSelfDescription } from '../components/AnuSelfDescription';
import type { SyncHealth } from '../hooks/useSyncDiagnostics';
import { buildInfo } from '../utils/buildInfo';

export interface DiagnosticLog {
  t: string;
  m: string;
  type: 'info' | 'error';
}

interface DiagnosticsPageProps {
  syncHealth: Record<string, SyncHealth>;
  logs: DiagnosticLog[];
  selectedModel: string;
  apiKey: string;
  isAiActive: boolean;
  onClearLogs: () => void;
}

export function DiagnosticsPage({
  syncHealth,
  logs,
  selectedModel,
  apiKey,
  isAiActive,
  onClearLogs,
}: DiagnosticsPageProps) {
  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-black text-white uppercase tracking-widest">
          Diagnostika systému (v{buildInfo.version})
        </h2>
        <button
          onClick={onClearLogs}
          className="px-3 py-1 bg-slate-800 hover:bg-red-900/20 text-slate-400 hover:text-red-400 rounded-lg text-sm font-black uppercase transition-all"
        >
          Smazat
        </button>
      </div>
      <AnuSelfDescription />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="p-4 bg-slate-800/30 rounded-2xl border border-slate-800/50">
          <h3 className="text-xs font-black text-slate-500 uppercase mb-3">Build a prostředí</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-slate-500">Verze:</span> <span className="text-white">{buildInfo.version}</span>
            </div>
            <div>
              <span className="text-slate-500">Kanál:</span> <span className="text-white">{buildInfo.channelLabel}</span>
            </div>
            <div className="sm:col-span-2">
              <span className="text-slate-500">Origin:</span> <span className="text-white break-all">{buildInfo.origin}</span>
            </div>
            <div>
              <span className="text-slate-500">Build:</span> <span className="text-white">{buildInfo.buildTime}</span>
            </div>
            <div>
              <span className="text-slate-500">Commit:</span>{' '}
              <span className="text-white">{buildInfo.commit ? buildInfo.commit.slice(0, 12) : 'local'}</span>
            </div>
            <div className="sm:col-span-2">
              <span className="text-slate-500">OAuth:</span> <span className="text-slate-300">{buildInfo.oauthOriginHint}</span>
            </div>
          </div>
        </div>
        <div className="p-4 bg-slate-800/30 rounded-2xl border border-slate-800/50">
          <h3 className="text-xs font-black text-slate-500 uppercase mb-3">Sync stav</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.entries(syncHealth).map(([key, item]) => {
              const tone = item.state === 'ok' ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                : item.state === 'error' ? 'text-red-400 bg-red-500/10 border-red-500/20'
                  : item.state === 'stale' ? 'text-amber-300 bg-amber-500/10 border-amber-500/20'
                    : 'text-slate-400 bg-slate-900/50 border-slate-700/50';
              return (
                <div key={key} className={`p-3 rounded-xl border ${tone}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-black uppercase tracking-widest">{item.label}</span>
                    <span className="text-[10px] font-black uppercase">{item.state}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">{item.detail}</p>
                  {item.lastSuccess && <p className="mt-1 text-[10px] text-slate-500">OK: {item.lastSuccess}</p>}
                  {item.lastError && <p className="mt-1 text-[10px] text-red-300 break-all">Chyba: {item.lastError}</p>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex-1 bg-slate-900/50 rounded-2xl border border-slate-800 overflow-y-auto p-4 font-mono text-xs space-y-1">
        {logs.length === 0 ? (
          <div className="text-slate-600 italic">Žádné logy k dispozici...</div>
        ) : (
          logs.map((log, index) => (
            <div key={index} className={`flex gap-3 ${log.type === 'error' ? 'text-red-400 bg-red-400/5' : 'text-slate-400'} py-1 px-2 rounded`}>
              <span className="opacity-50 shrink-0">[{log.t}]</span>
              <span className="break-all">{log.m}</span>
            </div>
          ))
        )}
      </div>
      <div className="p-4 bg-slate-800/30 rounded-2xl border border-slate-800/50">
        <h3 className="text-xs font-black text-slate-500 uppercase mb-2">Aktivní Konfigurace</h3>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-slate-500">Model:</span> <span className="text-white">{selectedModel}</span>
          </div>
          <div>
            <span className="text-slate-500">API Stav:</span>{' '}
            <span className={isAiActive ? 'text-emerald-400' : 'text-red-400'}>
              {isAiActive ? 'Aktivní' : 'Chybí klíč/Offline'}
            </span>
          </div>
          <div className="col-span-2">
            <span className="text-slate-500">Klíč:</span> <span className="text-white">...{apiKey.slice(-6)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
