import { useEffect, useRef, useState } from 'react';
import { Workbox } from 'workbox-window';
import { createPwaUpdateConsent } from '../utils/pwaUpdateConsent';

export function PwaUpdatePrompt() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const acceptUpdate = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

    const worker = new Workbox(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
    const consent = createPwaUpdateConsent(
      () => worker.messageSkipWaiting(),
      () => window.location.reload(),
    );
    acceptUpdate.current = consent.accept;
    const waiting = () => setAvailable(true);
    const controlling = (event: { isUpdate?: boolean; isExternal?: boolean }) => {
      if (event.isUpdate || event.isExternal) {
        setAvailable(true);
        consent.controlling();
      }
    };
    worker.addEventListener('waiting', waiting);
    worker.addEventListener('controlling', controlling);
    void worker.register().catch(error => console.warn('PWA registration failed', error));
    return () => {
      acceptUpdate.current = null;
      worker.removeEventListener('waiting', waiting);
      worker.removeEventListener('controlling', controlling);
    };
  }, []);

  if (!available) return null;

  return (
    <aside aria-label="Aktualizace aplikace" className="fixed bottom-24 right-4 left-4 z-[150] rounded-2xl border border-[var(--control-border)] bg-[var(--surface-1)] p-4 text-[var(--text-primary)] shadow-xl sm:left-auto sm:w-96">
      {dismissed ? (
        <button type="button" className="min-h-11 w-full text-sm font-semibold" onClick={() => setDismissed(false)}>
          K dispozici je aktualizace
        </button>
      ) : (
        <>
          <p role="status" className="font-semibold">Je připravena nová verze</p>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">Nejprve uložte rozpracované změny a dokončete nahrávání. Aktualizace obnoví tuto stránku.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="office-button-primary min-h-11" onClick={() => {
              if (window.confirm('Máte uložené změny a dokončené nahrávání? Aktualizovat a obnovit stránku?')) {
                acceptUpdate.current?.();
              }
            }}>Aktualizovat</button>
            <button type="button" className="min-h-11 rounded-xl border border-[var(--control-border)] px-4 text-sm font-semibold" onClick={() => setDismissed(true)}>Později</button>
          </div>
        </>
      )}
    </aside>
  );
}
