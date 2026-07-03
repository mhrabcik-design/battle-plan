import { useEffect } from 'react';
import { agentBridge } from '../services/agentBridge';
import type { GoogleAuthStatus } from '../types';

interface UseAgentBridgePollingArgs {
  googleAuth: GoogleAuthStatus;
  addLog: (message: string, type?: 'info' | 'error') => void;
}

export function useAgentBridgePolling({ googleAuth, addLog }: UseAgentBridgePollingArgs) {
  useEffect(() => {
    if (!googleAuth.isSignedIn) return;

    let cancelled = false;

    const checkAgentWrites = async () => {
      if (cancelled) return;
      try {
        await agentBridge.init();
        if (!agentBridge.initialized) return;

        const writes = await agentBridge.fetchPendingWrites();
        if (writes.length === 0) return;
        if (cancelled) return;

        addLog(`Anu: ${writes.length} nových zápisů ke zpracování`);

        const applied: string[] = [];
        for (const w of writes) {
          if (cancelled) break;
          const result = await agentBridge.applyWrite(w);
          if (result.success) applied.push(w.id);
        }

        if (applied.length > 0 && !cancelled) {
          await agentBridge.markApplied(applied);
          addLog(`Anu: ${applied.length} zápisů úspěšně aplikováno`);
        }
      } catch (e) {
        console.error('Agent bridge failed', e);
      }
    };

    const initialTimer = setTimeout(checkAgentWrites, 3000);
    const interval = setInterval(checkAgentWrites, 30_000);

    return () => {
      cancelled = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [googleAuth.isSignedIn, addLog]);
}

