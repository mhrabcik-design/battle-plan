import { useEffect } from 'react';
import { suggestionsSync } from '../services/suggestionsSync';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';
import type { SyncHealth } from './useSyncDiagnostics';
import { driveUnavailableHealth, emptySuggestionsHealth } from '../utils/driveSyncDiagnostics';

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface UseSuggestionsBadgeArgs {
  googleAuth: GoogleAuthStatus;
  setSuggestionsBadge: (count: number) => void;
  updateSyncHealth: (key: string, patch: Partial<SyncHealth>) => void;
}

export function useSuggestionsBadge({ googleAuth, setSuggestionsBadge, updateSyncHealth }: UseSuggestionsBadgeArgs) {
  const hasUsableAuthValue = hasUsableAuth(googleAuth);

  useEffect(() => {
    if (!hasUsableAuthValue) {
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
          updateSyncHealth('suggestions', driveUnavailableHealth(suggestionsSync.status));
          return;
        }
        const suggestionsResult = await suggestionsSync.fetchSuggestionsDetailed();
        if (suggestionsResult.kind === 'store-unavailable') {
          updateSyncHealth('suggestions', driveUnavailableHealth(suggestionsResult.status));
          return;
        }
        if (suggestionsResult.kind === 'error') {
          updateSyncHealth('suggestions', {
            state: 'error',
            detail: 'Načtení návrhů selhalo',
            lastError: suggestionsResult.message,
          });
          return;
        }
        const sugs = suggestionsResult.suggestions;
        const open = sugs.filter((s) => s.status === 'open').length;
        setSuggestionsBadge(open);
        updateSyncHealth('suggestions', {
          state: 'ok',
          detail: suggestionsResult.kind === 'missing-file' ? emptySuggestionsHealth().detail : `${open} otevřených návrhů`,
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
  }, [hasUsableAuthValue, setSuggestionsBadge, updateSyncHealth]);
}

