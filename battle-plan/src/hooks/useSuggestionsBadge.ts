import { useEffect } from 'react';
import { suggestionsSync } from '../services/suggestionsSync';
import { googleService } from '../services/googleService';
import type { GoogleAuthStatus } from '../types';
import { hasUsableAuth, isAuthUnavailable } from '../types';
import type { SyncHealth } from './useSyncDiagnostics';
import {
  driveUnavailableHealth,
  emptySuggestionsHealth,
  GOOGLE_DRIVE_RECONSENT_MESSAGE,
  isDriveScopeError,
} from '../utils/driveSyncDiagnostics';
import { getErrorMessage } from '../utils/errors';

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
        if (isAuthUnavailable(authAfterFetch.state)) {
          return;
        }
        if (suggestionsResult.kind === 'store-unavailable') {
          updateSyncHealth('suggestions', driveUnavailableHealth(suggestionsResult.status));
          if (suggestionsResult.status.code === 'auth-unavailable') {
            addLog(GOOGLE_DRIVE_RECONSENT_MESSAGE, 'error');
          }
          return;
        }
        if (suggestionsResult.kind === 'error') {
          updateSyncHealth('suggestions', {
            state: 'error',
            detail: 'Načtení návrhů selhalo',
            lastError: suggestionsResult.message,
          });
          if (isDriveScopeError(suggestionsResult.message)) {
            addLog(GOOGLE_DRIVE_RECONSENT_MESSAGE, 'error');
          }
          return;
        }
        const sugs = suggestionsResult.suggestions;
        const open = sugs.filter((s) => s.status === 'open').length;
        setSuggestionsBadge(open);
        // Race guard: if markAuthUnavailable flipped the auth state to
        // OFFLINE_AUTH / SIGNED_OUT while we were inside the await chain
        // above, do NOT overwrite the 'idle' state the useEffect re-run
        // already installed. Mirrors the guard in
        // useDriveSyncOrchestration.checkSync.
        const authBeforeSuggestionsOk = googleService.getAuthStatus();
        if (!isAuthUnavailable(authBeforeSuggestionsOk.state)) {
          updateSyncHealth('suggestions', {
            state: 'ok',
            detail: suggestionsResult.kind === 'missing-file' ? emptySuggestionsHealth().detail : `${open} otevřených návrhů`,
            lastSuccess: new Date().toLocaleString('cs-CZ'),
            lastError: null,
          });
        }
      } catch (e) {
        const lastErrorString = getErrorMessage(e);
        updateSyncHealth('suggestions', {
          state: 'error',
          detail: 'Načtení návrhů selhalo',
          lastError: lastErrorString,
        });
        if (isDriveScopeError(lastErrorString)) {
          addLog(GOOGLE_DRIVE_RECONSENT_MESSAGE, 'error');
        }
      }
    };

    refreshBadge();
    const t = setInterval(refreshBadge, 60_000);
    return () => clearInterval(t);
  }, [hasUsableAuthValue, setSuggestionsBadge, updateSyncHealth, addLog]);
}

