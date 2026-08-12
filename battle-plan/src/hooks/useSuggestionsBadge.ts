import { useEffect } from 'react';
import { suggestionsSync } from '../services/suggestionsSync';
import { effectiveSuggestionStatus, suggestionRegistry } from '../services/suggestionRegistry';
import { suggestionRegistrySync } from '../services/suggestionRegistrySync';
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
import { resolveSuggestionsSnapshot } from '../utils/suggestionReplies';

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

    let refreshInFlight = false;
    const refreshBadge = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        await suggestionsSync.init();
        if (!suggestionsSync.initialized) {
          updateSyncHealth('suggestions', driveUnavailableHealth(suggestionsSync.status));
          return;
        }
        const [suggestionsResult, repliesResult, registryFetchResult] = await Promise.all([
          suggestionsSync.fetchSuggestionsDetailed(),
          suggestionsSync.fetchRepliesDetailed(),
          suggestionRegistrySync.fetchAndMerge(),
        ]);
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
        if (registryFetchResult.kind === 'error' || registryFetchResult.kind === 'store-unavailable') {
          const message = registryFetchResult.kind === 'error'
            ? registryFetchResult.message
            : 'Registr rozhodnutí není na Google Drive dostupný.';
          updateSyncHealth('suggestions', {
            state: 'error',
            detail: 'Synchronizace rozhodnutí selhala',
            lastError: message,
          });
          addLog(message, 'error');
          return;
        }
        const sugs = suggestionsResult.suggestions;
        const snapshot = resolveSuggestionsSnapshot(sugs, repliesResult);
        if (snapshot.kind === 'preserve') {
          updateSyncHealth('suggestions', {
            state: 'error',
            detail: 'Načtení odpovědí selhalo',
            lastError: snapshot.message,
          });
          addLog(snapshot.message, 'error');
          return;
        }
        const replies = Object.values(snapshot.repliesBySuggestion).flat();
        await suggestionRegistry.ingestLegacy(sugs, replies);
        const registryPublishResult = await suggestionRegistrySync.publishPending();
        if (registryPublishResult.kind === 'error' || registryPublishResult.kind === 'store-unavailable') {
          const message = registryPublishResult.kind === 'error'
            ? registryPublishResult.message
            : 'Registr rozhodnutí není na Google Drive dostupný.';
          updateSyncHealth('suggestions', {
            state: 'error',
            detail: 'Uložení rozhodnutí selhalo',
            lastError: message,
          });
          addLog(message, 'error');
          return;
        }
        const resolutions = await suggestionRegistry.resolveMany(sugs);
        const open = sugs.filter((suggestion, index) =>
          effectiveSuggestionStatus(suggestion, resolutions[index]) === 'open'
        ).length;
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
      } finally {
        refreshInFlight = false;
      }
    };

    refreshBadge();
    const t = setInterval(refreshBadge, 60_000);
    return () => clearInterval(t);
  }, [hasUsableAuthValue, setSuggestionsBadge, updateSyncHealth, addLog]);
}

