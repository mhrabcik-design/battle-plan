import { useEffect } from 'react';
import { agentBridge } from '../services/agentBridge';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';

interface UseAgentBridgePollingArgs {
  googleAuth: GoogleAuthStatus;
  addLog: (message: string, type?: 'info' | 'error') => void;
}

export function useAgentBridgePolling({ googleAuth, addLog }: UseAgentBridgePollingArgs) {
  const hasUsableAuthValue = hasUsableAuth(googleAuth);

  useEffect(() => {
    if (!hasUsableAuthValue) return;

    let cancelled = false;

    const checkAgentWrites = async () => {
      if (cancelled) return;
      try {
        await agentBridge.init();
        if (!agentBridge.initialized) return;

        const writes = await agentBridge.fetchPendingWrites();
        if (writes.length > 0) {
          // U5: mirror the inbox file into db.agentInbox before applying so
          // the diagnostics surface can read pending writes via useLiveQuery.
          await agentBridge.mirrorInbox(writes);
        }
        if (writes.length === 0) return;
        if (cancelled) return;

        addLog(`Anu: ${writes.length} nových zápisů ke zpracování`);

        const applied: string[] = [];
        for (const w of writes) {
          if (cancelled) break;
          const result = await agentBridge.applyWrite(w);
          if (result.success) {
            applied.push(w.id);
            await agentBridge.recordInboxResult(w.id, true);
          } else {
            await agentBridge.recordInboxResult(w.id, false, result.last_error);
          }
        }

        if (applied.length > 0 && !cancelled) {
          await agentBridge.markApplied(applied);
          addLog(`Anu: ${applied.length} zápisů úspěšně aplikováno`);
        }
      } catch (e) {
        console.error('Agent bridge failed', e);
      }
    };

    // 5s cadence is the production cadence. Faster than the previous 30s
    // so Anu writes surface in seconds, not half a minute. Paired with the
    // visibilitychange / focus listeners below, the latency is bounded by
    // the time between Anu writing and the next user-facing event.
    const initialTimer = setTimeout(checkAgentWrites, 3000);
    const interval = setInterval(checkAgentWrites, 5_000);

    // Flush pending writes when the tab returns to the foreground so the user
    // sees agent activity without waiting for the next polling tick. The
    // precedent is useDriveSyncOrchestration.ts:239-247.
    const handleVisibility = (): void => { void checkAgentWrites(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
    };
  }, [hasUsableAuthValue, addLog]);
}
