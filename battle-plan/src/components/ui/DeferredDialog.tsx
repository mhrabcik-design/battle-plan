import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { PageErrorBoundary } from '../PageErrorBoundary';
import { OverlaySurface } from './OverlaySurface';

/** Pending and failed chunks keep keyboard focus inside a dismissible surface. */
export function DeferredDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => () => {
    // The pending surface is replaced by the loaded dialog. Keep the original
    // opener across that swap and restore after child overlay cleanup has run.
    queueMicrotask(() => requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    }));
  }, [opener]);

  const fallback = (failed: boolean) => (
    <OverlaySurface title={title} onRequestClose={onClose} className="theme-surface w-full max-w-md rounded-2xl border border-white/10 p-6 shadow-xl">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button type="button" className="surface-action" aria-label="Zavřít načítání" onClick={onClose}><X className="h-4 w-4" /></button>
      </div>
      <p role={failed ? 'alert' : 'status'} className="my-6 flex items-center gap-3 text-sm text-slate-400">
        {!failed && <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />}
        {failed ? 'Tuto část se nepodařilo načíst. Zkuste obnovit aplikaci.' : 'Načítám…'}
      </p>
      {failed && <button type="button" className="office-button-primary" onClick={() => window.location.reload()}><RefreshCw className="h-4 w-4" /> Obnovit aplikaci</button>}
    </OverlaySurface>
  );
  return <PageErrorBoundary resetKey={title} fallback={fallback(true)}><Suspense fallback={fallback(false)}>{children}</Suspense></PageErrorBoundary>;
}
