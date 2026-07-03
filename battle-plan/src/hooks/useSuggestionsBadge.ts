import { useEffect } from 'react';
import { suggestionsSync } from '../services/suggestionsSync';
import type { GoogleAuthStatus } from '../types';
import type { SyncHealth } from './useSyncDiagnostics';

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface UseSuggestionsBadgeArgs {
  googleAuth: GoogleAuthStatus;
  setSuggestionsBadge: (count: number) => void;
  updateSyncHealth: (key: string, patch: Partial<SyncHealth>) => void;
}

export function useSuggestionsBadge({ googleAuth, setSuggestionsBadge, updateSyncHealth }: UseSuggestionsBadgeArgs) {
  useEffect(() => {
    if (!googleAuth.isSignedIn) {
      queueMicrotask(() => {
        setSuggestionsBadge(0);
        updateSyncHealth('suggestions', { state: 'idle', detail: 'Čeká na Google přihlášení' });
      });
      return;
    }

    const refreshBadge = async () => {
      try {
        await suggestionsSync.init();
        if (!suggestionsSync.initialized) {
          updateSyncHealth('suggestions', { state: 'stale', detail: 'Suggestions sync není inicializovaný' });
          return;
        }
        const sugs = await suggestionsSync.fetchSuggestions();
        const open = sugs.filter((s) => s.status === 'open').length;
        setSuggestionsBadge(open);
        updateSyncHealth('suggestions', {
          state: 'ok',
          detail: `${open} otevřených návrhů`,
          lastSuccess: new Date().toLocaleString('cs-CZ'),
          lastError: null,
        });
      } catch (e) {
        updateSyncHealth('suggestions', {
          state: 'error',
          detail: 'Načtení návrhů selhalo',
          lastError: formatError(e),
        });
      }
    };

    refreshBadge();
    const t = setInterval(refreshBadge, 60_000);
    return () => clearInterval(t);
  }, [googleAuth.isSignedIn, setSuggestionsBadge, updateSyncHealth]);
}

