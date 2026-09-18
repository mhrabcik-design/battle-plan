import { useEffect } from 'react';
import { agentBridge, shouldAcknowledgeApplyWrite } from '../services/agentBridge';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';
import { createProtocolPollingCoordinator } from '../services/agentProtocol/pollingCoordinator.ts';

const coordinator = createProtocolPollingCoordinator();
type Bridge = Pick<typeof agentBridge, 'init' | 'initialized' | 'fetchPendingWrites' | 'mirrorInbox' | 'applyWrite' | 'recordInboxResult' | 'markApplied'>;

interface UseAgentBridgePollingArgs {
  googleAuth: GoogleAuthStatus;
  addLog: (message: string, type?: 'info' | 'error') => void;
}

export function createAgentBridgePoller(bridge: Bridge, addLog: UseAgentBridgePollingArgs['addLog']) {
    let cancelled = false;
    const poll = () => coordinator.run('legacy-agent-bridge', async () => {
        if (cancelled) return;
        await bridge.init();
        if (cancelled || !bridge.initialized) return;

        const writes = await bridge.fetchPendingWrites();
        if (cancelled) return;
        if (writes.length > 0) {
          // U5: mirror the inbox file into db.agentInbox before applying so
          // the diagnostics surface can read pending writes via useLiveQuery.
          await bridge.mirrorInbox(writes);
        }
        if (writes.length === 0) return;
        if (cancelled) return;

        addLog(`Anu: ${writes.length} nových zápisů ke zpracování`);

        const acknowledged: string[] = [];
        let appliedCount = 0;
        let terminalCount = 0;
        for (const w of writes) {
          if (cancelled) break;
          const result = await bridge.applyWrite(w);
          if (shouldAcknowledgeApplyWrite(result)) {
            acknowledged.push(w.id);
          }
          if (result.success) {
            appliedCount++;
            await bridge.recordInboxResult(w.id, true);
          } else if (result.disposition === 'terminal') {
            terminalCount++;
            await bridge.recordInboxResult(w.id, true, result.last_error);
          } else {
            await bridge.recordInboxResult(w.id, false, result.last_error);
          }
        }

        if (acknowledged.length > 0) {
          // Finish acknowledgements for mutations already applied before a
          // teardown, but do not begin another mutation or update stale UI.
          await bridge.markApplied(acknowledged);
        }
        if (!cancelled && appliedCount > 0) {
          addLog(`Anu: ${appliedCount} zápisů úspěšně aplikováno`);
        }
        if (!cancelled && terminalCount > 0) {
          addLog(`Anu: ${terminalCount} neplatných zápisů odmítnuto`, 'error');
        }
    }).catch((error) => {
        if (!cancelled) console.error('Agent bridge failed', error);
    });
    return { poll, stop: () => { cancelled = true; } };
}

export function useAgentBridgePolling({ googleAuth, addLog }: UseAgentBridgePollingArgs) {
  const hasUsableAuthValue = hasUsableAuth(googleAuth);

  useEffect(() => {
    if (!hasUsableAuthValue) return;
    const poller = createAgentBridgePoller(agentBridge, addLog);
    const checkAgentWrites = poller.poll;

    // 5s cadence is the production cadence. Faster than the previous 30s
    // so Anu writes surface in seconds, not half a minute. Paired with the
    // visibilitychange / focus listeners below, the latency is bounded by
    // the time between Anu writing and the next user-facing event.
    const initialTimer = setTimeout(checkAgentWrites, 3000);
    const interval = setInterval(checkAgentWrites, 5_000);

    // Flush pending writes when the tab returns to the foreground so the user
    // sees agent activity without waiting for the next polling tick. The
    // same events are used by Drive synchronization.
    const handleVisibility = (): void => { void checkAgentWrites(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);

    return () => {
      poller.stop();
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
    };
  }, [hasUsableAuthValue, addLog]);
}
