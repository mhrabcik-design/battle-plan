import { useEffect } from 'react';
import { suggestionsSync } from '../services/suggestionsSync';
import { googleService } from '../services/googleService';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth } from '../types';
import type { SyncHealth } from './useSyncDiagnostics';
import { driveUnavailableHealth, emptySuggestionsHealth } from '../utils/driveSyncDiagnostics';

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface UseSuggestionsBadgeArgs {
  googleAuth: GoogleAuthStatus;
  setSuggestionsBadge: (count: number) => void;
  updateSyncHealth: (key: string, patch: Partial<SyncHealth>) => void;
  addLog: (message: string, type?: 'info' | 'error') => void;
}
export function useSuggestionsBadge({ googleAuth, setSuggestionsBadge, updateSyncHealth, addLog }: UseSuggestionsBadgeArgs) {
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
        const authAfterFetch = googleService.getAuthStatus();
        if (authAfterFetch.state === 'OFFLINE_AUTH' || authAfterFetch.state === 'SIGNED_OUT') {
            console.log('[sync-debug]', Date.now(), 'aborting suggestions refresh — auth unavailable', { state: authAfterFetch.state });
            return;
        }
        if (suggestionsResult.kind === 'store-unavailable') {
          updateSyncHealth('suggestions', driveUnavailableHealth(suggestionsResult.status));
          if (suggestionsResult.status.code === 'auth-unavailable') {
            addLog(
              "Drive odmítl požadavek: scope tvořiho Google účtu neobsahuje aktuální scopes aplikace. Jdi na https://myaccount.google.com/permissions, odeber 'Battle Plan', a přihlaš se znovu.",
              'error'
            );
          }
          return;
        }
        if (suggestionsResult.kind === 'error') {
          updateSyncHealth('suggestions', {
            state: 'error',
            detail: 'Načtení návrhů selhalo',
            lastError: suggestionsResult.message,
          });
          if (/403|PERMISSION_DENIED|Insufficient Authentication Scopes/.test(suggestionsResult.message)) {
            console.log('[sync-debug]', Date.now(), 'suggestions: detected 403 PERMISSION_DENIED — alerting user');
            addLog(
              "Drive odmítl požadavek: scope tvořiho Google účtu neobsahuje aktuální scopes aplikace. Jdi na https://myaccount.google.com/permissions, odeber 'Battle Plan', a přihlaš se znovu.",
              'error'
            );
          }
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
        const errorMessage = formatError(e);
        const lastErrorString = typeof errorMessage === 'string' ? errorMessage : String(errorMessage);
        updateSyncHealth('suggestions', {
          state: 'error',
          detail: 'Načtení návrhů selhalo',
          lastError: lastErrorString,
        });
        console.log('[sync-debug]', Date.now(), 'suggestions refresh threw', { lastErrorString, e });
        if (/403|PERMISSION_DENIED|Insufficient Authentication Scopes/.test(lastErrorString)) {
          addLog(
            "Drive odmítl požadavek: scope tvořiho Google účtu neobsahuje aktuální scopes aplikace. Jdi na https://myaccount.google.com/permissions, odeber 'Battle Plan', a přihlaš se znovu.",
            'error'
          );
        }
      }
    };

    refreshBadge();
    const t = setInterval(refreshBadge, 60_000);
    return () => clearInterval(t);
  }, [hasUsableAuthValue, setSuggestionsBadge, updateSyncHealth, addLog]);
}

