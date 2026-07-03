import { useEffect } from 'react';
import { db } from '../db';
import { googleService } from '../services/googleService';
import { mergeCloudToLocal, mergeLocalToCloud, type MergeResult, workLogsSync } from '../services/workLogsSync';
import { taskDriveBackup } from '../services/taskDriveBackup';
import { getMissingWorkLogsFileStatus, hasLocalWorkLogsData } from '../utils/workLogsSyncStatus';
import type { GoogleAuthStatus, GoogleTaskList } from '../types';
import { hasUsableAuth } from '../types';
import type { SyncHealth } from './useSyncDiagnostics';

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface UseDriveSyncOrchestrationArgs {
  googleAuth: GoogleAuthStatus;
  setGoogleAuth: (status: GoogleAuthStatus) => void;
  setGoogleTaskLists: (lists: GoogleTaskList[]) => void;
  setApiKey: (value: string) => void;
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
  setApiKey,
  setSelectedModel,
  setUiScale,
  setLastSync,
  addLog,
  updateSyncHealth,
}: UseDriveSyncOrchestrationArgs) {
  const hasUsableAuthValue = hasUsableAuth(googleAuth);

  useEffect(() => {
    if (!hasUsableAuthValue) {
      queueMicrotask(() => {
        updateSyncHealth('tasks', { state: 'idle', detail: 'Čeká na Google přihlášení' });
        updateSyncHealth('worklogs', { state: 'idle', detail: 'Čeká na Google přihlášení' });
      });
      return;
    }

    googleService.getTaskLists().then(setGoogleTaskLists);

    const checkSync = async () => {
      try {
        const status = googleService.getAuthStatus();
        if (status.state !== 'SIGNED_IN' && localStorage.getItem('google_access_token')) {
          const success = await googleService.trySilentRefresh();
          if (success) {
            setGoogleAuth(googleService.getAuthStatus());
          }
        }

        const payload = await taskDriveBackup.load();
        if (payload && payload.data) {
          const cloudTimestamp = payload.timestamp || 0;

          const { tasks: driveTasks, settings: driveSettings } = payload.data;

          if (driveSettings) {
            for (const s of driveSettings) {
              await db.settings.put(s);
              if (s.id === 'gemini_api_key') setApiKey(s.value);
              if (s.id === 'gemini_model') setSelectedModel(s.value);
              if (s.id === 'ui_scale') setUiScale(Number(s.value));
            }
          }

          if (driveTasks && Array.isArray(driveTasks)) {
            let changesMade = false;
            await db.transaction('rw', db.tasks, async () => {
              for (const cloudTask of driveTasks) {
                if (!cloudTask.id) continue;
                const localTask = await db.tasks.get(cloudTask.id);

                if (!localTask) {
                  await db.tasks.add(cloudTask);
                  changesMade = true;
                } else {
                  const cloudUpdated = cloudTask.updatedAt || cloudTask.createdAt || 0;
                  const localUpdated = localTask.updatedAt || localTask.createdAt || 0;

                  if (cloudUpdated > localUpdated) {
                    await db.tasks.put(cloudTask);
                    changesMade = true;
                  }
                }
              }
            });

            if (changesMade) {
              addLog(`Synchronizace: Staženy novější změny z cloudu.`);
            }
          }

          const now = new Date().toLocaleString('cs-CZ');
          setLastSync(now);
          localStorage.setItem('last_drive_sync', now);
          localStorage.setItem('last_drive_sync_ts', cloudTimestamp.toString());
          updateSyncHealth('tasks', {
            state: 'ok',
            detail: 'Drive data načtena',
            lastSuccess: now,
            lastError: null,
          });
        } else {
          updateSyncHealth('tasks', {
            state: 'stale',
            detail: 'Drive data nejsou dostupná nebo jsou prázdná',
          });
        }

        await workLogsSync.init();
        if (workLogsSync.initialized) {
          const wl = await workLogsSync.loadAll();
          if (wl.timestamp > 0) {
            const mergeResult: MergeResult = await mergeCloudToLocal(wl.workLogs, wl.projects);
            if (mergeResult.workLogsAdded > 0 || mergeResult.workLogsUpdated > 0 ||
                mergeResult.projectsAdded > 0 || mergeResult.projectsUpdated > 0) {
              addLog(
                `WorkLogs sync: +${mergeResult.workLogsAdded} logů, ~${mergeResult.workLogsUpdated} upd, +${mergeResult.projectsAdded} projektů, ~${mergeResult.projectsUpdated} upd.`,
                'info'
              );
            }
            updateSyncHealth('worklogs', {
              state: 'ok',
              detail: wl.timestamp > 0 ? 'WorkLogs načteny z Drive' : 'WorkLogs soubor zatím neexistuje',
              lastSuccess: new Date().toLocaleString('cs-CZ'),
              lastError: null,
            });
          } else {
            const localCounts = {
              workLogs: await db.workLogs.count(),
              projects: await db.projects.count(),
            };
            const missingStatus = getMissingWorkLogsFileStatus(localCounts);
            updateSyncHealth('worklogs', {
              state: missingStatus.state,
              detail: missingStatus.detail,
              lastError: null,
            });
            if (hasLocalWorkLogsData(localCounts)) {
              const created = await mergeLocalToCloud();
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
          updateSyncHealth('worklogs', {
            state: 'stale',
            detail: 'WorkLogs sync není inicializovaný',
          });
        }
      } catch (e) {
        console.error("Auto-sync check failed", e);
        const message = formatError(e);
        updateSyncHealth('tasks', {
          state: 'error',
          detail: 'Automatická synchronizace selhala',
          lastError: message,
        });
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
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', checkSync);
    };
  }, [hasUsableAuthValue, setGoogleAuth, setGoogleTaskLists, setApiKey, setSelectedModel, setUiScale, setLastSync, addLog, updateSyncHealth]);
}

