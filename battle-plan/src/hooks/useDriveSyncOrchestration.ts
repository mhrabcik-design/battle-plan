import { useEffect, useState } from 'react';
import { db } from '../db';
import { googleService } from '../services/googleService';
import { mergeCloudToLocal, mergeLocalToCloud, type MergeResult, workLogsSync } from '../services/workLogsSync';
import { taskDriveBackup } from '../services/taskDriveBackup';
import { mergeTasksFromDrive } from '../services/taskMerge.ts';
import { getMissingWorkLogsFileStatus, hasLocalWorkLogsData } from '../utils/workLogsSyncStatus';
import type { GoogleAuthStatus, GoogleTaskList } from '../types';
import { hasUsableAuth, isAuthUnavailable } from '../types';
import type { SyncHealth } from './useSyncDiagnostics';
import { hydrateTaskBackup } from './taskBackupCoordinator.ts';
import { filterTaskBackupSettings } from '../utils/taskBackupSettings.ts';
import {
  autoSyncFailureHealth,
  driveUnavailableHealth,
  GOOGLE_DRIVE_RECONSENT_MESSAGE,
  isDriveScopeError,
  taskBackupHealth,
} from '../utils/driveSyncDiagnostics';

interface UseDriveSyncOrchestrationArgs {
  googleAuth: GoogleAuthStatus;
  setGoogleAuth: (status: GoogleAuthStatus) => void;
  setGoogleTaskLists: (lists: GoogleTaskList[]) => void;
  setSelectedModel: (value: string) => void;
  setUiScale: (value: number) => void;
  setLastSync: (value: string | null) => void;
  addLog: (message: string, type?: 'info' | 'error') => void;
  updateSyncHealth: (key: string, patch: Partial<SyncHealth>) => void;
}

export function useDriveSyncOrchestration({
  googleAuth,
  setGoogleAuth,
  setGoogleTaskLists,
  setSelectedModel,
  setUiScale,
  setLastSync,
  addLog,
  updateSyncHealth,
}: UseDriveSyncOrchestrationArgs) {
  const hasUsableAuthValue = hasUsableAuth(googleAuth);
  const accessToken = googleAuth.accessToken;
  const [hydrated, setHydrated] = useState<{ accessToken: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    if (!hasUsableAuthValue) {
      queueMicrotask(() => {
        if (cancelled) return;
        setHydrated(null);
        updateSyncHealth('tasks', { state: 'idle', detail: 'Čeká na Google přihlášení' });
        updateSyncHealth('worklogs', { state: 'idle', detail: 'Čeká na Google přihlášení' });
      });
      return () => { cancelled = true; };
    }

    const checkSync = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        const status = googleService.getAuthStatus();
        if (status.state === 'REFRESH_PENDING') {
          const success = await googleService.runRefresh();
          if (cancelled) return;
          if (success) {
            setGoogleAuth(googleService.getAuthStatus());
          }
        }
        // Fetch the user's Google Tasks lists so the picker in App.tsx can
        // render them on the Tasks view. getTaskLists honors the per-feature
        // googleTasksScopeAvailable flag and returns [] when the user lacks
        // the Tasks scope; the 4.3.24 403 swallow means a missing-scope user
        // pays one cheap call. Errors are isolated so a slow / failed list
        // fetch does not block the rest of the sync.
        try {
          const lists = await googleService.getTaskLists();
          if (cancelled) return;
          setGoogleTaskLists(lists);
        } catch (e) {
          if (cancelled) return;
          console.error('Google Tasks list fetch failed', e);
          setGoogleTaskLists([]);
        }
        const { result: taskBackup, ready } = await hydrateTaskBackup(
          () => taskDriveBackup.loadDetailed(),
          async (payload) => {
            const payloadData = payload.data ?? {};
            const cloudTimestamp = payload.timestamp || 0;

            const { tasks: driveTasks, settings: driveSettings } = payloadData;

            if (driveSettings) {
              for (const s of filterTaskBackupSettings(driveSettings)) {
                await db.settings.put(s);
                if (cancelled) return;
                if (s.id === 'gemini_model') setSelectedModel(s.value);
                if (s.id === 'ui_scale') setUiScale(Number(s.value));
              }
            }

            if (driveTasks && Array.isArray(driveTasks)) {
              const changesMade = await mergeTasksFromDrive(driveTasks);
              if (cancelled) return;

              if (changesMade) {
                addLog(`Synchronizace: Staženy novější změny z cloudu.`);
              }
            }

            const now = new Date().toLocaleString('cs-CZ');
            setLastSync(now);
            localStorage.setItem('last_drive_sync', now);
            localStorage.setItem('last_drive_sync_ts', cloudTimestamp.toString());
            // Race guard: if markAuthUnavailable flipped the auth state to
            // OFFLINE_AUTH / SIGNED_OUT while we were inside the await chain
            // above (a typical case when the server returns 403 from a
            // different in-flight call, or the token was revoked by a
            // concurrent request), do NOT overwrite the 'idle' state the
            // useEffect re-run already installed. The data we just merged
            // into the local DB is still valid, but the UI must reflect the
            // current auth reality, not a stale success snapshot.
            const authBeforeTasksOk = googleService.getAuthStatus();
            if (!isAuthUnavailable(authBeforeTasksOk.state)) {
              updateSyncHealth('tasks', {
                state: 'ok',
                detail: 'Drive data načtena',
                lastSuccess: now,
                lastError: null,
              });
            }
          },
          () => !cancelled && !isAuthUnavailable(googleService.getAuthStatus().state),
        );
        if (cancelled || isAuthUnavailable(googleService.getAuthStatus().state)) return;
        if (ready) setHydrated({ accessToken });
        if (taskBackup.kind !== 'loaded') {
          updateSyncHealth('tasks', taskBackupHealth(taskBackup));
          const recoverable = taskBackup.kind === 'error'
            ? isDriveScopeError(taskBackup.message)
            : taskBackup.kind === 'store-unavailable' && taskBackup.status.code === 'auth-unavailable';
          if (recoverable) addLog(GOOGLE_DRIVE_RECONSENT_MESSAGE, 'error');
        }
        const authAfterTasks = googleService.getAuthStatus();
        if (isAuthUnavailable(authAfterTasks.state)) {
          return;
        }
        await workLogsSync.init();
        if (cancelled) return;
        if (workLogsSync.initialized) {
          const workLogsResult = await workLogsSync.loadAllDetailed();
          if (cancelled) return;
          const wl = workLogsResult.data;
          if (workLogsResult.kind === 'store-unavailable') {
            updateSyncHealth('worklogs', driveUnavailableHealth(workLogsResult.status));
          } else if (workLogsResult.kind === 'error') {
            updateSyncHealth('worklogs', {
              state: 'error',
              detail: 'Načtení WorkLogs z Drive selhalo',
              lastError: workLogsResult.message,
            });
          } else if (wl.timestamp > 0) {
            const mergeResult: MergeResult = await mergeCloudToLocal(
              wl.workLogs,
              wl.projects,
              wl.workLogDeletionTombstones,
            );
            if (cancelled) return;
            if (mergeResult.workLogsAdded > 0 || mergeResult.workLogsUpdated > 0 ||
                mergeResult.projectsAdded > 0 || mergeResult.projectsUpdated > 0) {
              addLog(
                `WorkLogs sync: +${mergeResult.workLogsAdded} logů, ~${mergeResult.workLogsUpdated} upd, +${mergeResult.projectsAdded} projektů, ~${mergeResult.projectsUpdated} upd.`,
                'info'
              );
            }
            updateSyncHealth('worklogs', {
              state: 'ok',
              detail: 'WorkLogs načteny z Drive',
              lastSuccess: new Date().toLocaleString('cs-CZ'),
              lastError: null,
            });
          } else {
            const localCounts = {
              workLogs: await db.workLogs.count(),
              projects: await db.projects.count(),
            };
            if (cancelled) return;
            const missingStatus = getMissingWorkLogsFileStatus(localCounts);
            updateSyncHealth('worklogs', {
              state: missingStatus.state,
              detail: missingStatus.detail,
              lastError: null,
            });
            if (hasLocalWorkLogsData(localCounts)) {
              const created = await mergeLocalToCloud();
              if (cancelled) return;
              updateSyncHealth('worklogs', created
                ? {
                    state: 'ok',
                    detail: 'WorkLogs soubor vytvořen na Drive',
                    lastSuccess: new Date().toLocaleString('cs-CZ'),
                    lastError: null,
                  }
                : {
                    state: 'error',
                    detail: 'WorkLogs soubor se nepodařilo vytvořit',
                  }
              );
              if (created) {
                addLog('WorkLogs soubor vytvořen na Drive', 'info');
              }
            }
          }
        } else {
          updateSyncHealth('worklogs', driveUnavailableHealth(workLogsSync.status));
        }
      } catch (e) {
        if (cancelled) return;
        console.error("Auto-sync check failed", e);
        const failure = autoSyncFailureHealth(e);
        updateSyncHealth(failure.key, failure.patch);
      } finally {
        running = false;
      }
    };

    checkSync();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkSync();
      }
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', checkSync);

    return () => {
      cancelled = true;
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', checkSync);
    };
  }, [hasUsableAuthValue, accessToken, setGoogleAuth, setGoogleTaskLists, setSelectedModel, setUiScale, setLastSync, addLog, updateSyncHealth]);

  return { taskBackupReady: hasUsableAuthValue && hydrated !== null && hydrated.accessToken === accessToken };
}

