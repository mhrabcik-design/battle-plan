import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { googleService } from '../services/googleService.ts';
import { hasUsableAuth, type GoogleAuthStatus, type GoogleTaskRaw, type ViewMode } from '../types.ts';

export function createGoogleTaskLoader(listId: string, onTasks: (tasks: GoogleTaskRaw[]) => void, onError: (error: unknown) => void) {
  let stopped = false;
  let generation = 0;
  return {
    async refresh() {
      if (stopped) return;
      const request = ++generation;
      try {
        const tasks = await googleService.getTasks(listId);
        if (!stopped && request === generation) onTasks(tasks);
      } catch (error) {
        if (!stopped && request === generation) onError(error);
      }
    },
    stop() { stopped = true; },
  };
}

type TaskScope = { listId: string; auth: GoogleAuthStatus };
const EMPTY_TASKS: GoogleTaskRaw[] = [];

export function useGoogleTasks(googleAuth: GoogleAuthStatus, viewMode: ViewMode, listId: string) {
  const enabled = hasUsableAuth(googleAuth) && (viewMode === 'battle' || viewMode === 'tasks' || viewMode === 'week');
  // An auth transition creates a new scope even when the same account signs in again.
  const scope = useMemo<TaskScope>(() => ({ listId, auth: googleAuth }), [listId, googleAuth]);
  const [snapshot, setSnapshot] = useState<{ scope: TaskScope; tasks: GoogleTaskRaw[] } | null>(null);
  const currentLoader = useRef<{ scope: TaskScope; loader: ReturnType<typeof createGoogleTaskLoader> } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const loader = createGoogleTaskLoader(
      scope.listId,
      tasks => setSnapshot({ scope, tasks }),
      error => console.error('Google Tasks loading failed', error),
    );
    const current = { scope, loader };
    currentLoader.current = current;
    void loader.refresh();
    return () => {
      loader.stop();
      if (currentLoader.current === current) currentLoader.current = null;
    };
  }, [enabled, scope]);

  const refreshGoogleTasks = useCallback(async () => {
    // A command from a previous list/session cannot refresh its replacement.
    const current = currentLoader.current;
    if (current?.scope === scope) await current.loader.refresh();
  }, [scope]);

  return {
    tasks: enabled && snapshot?.scope === scope ? snapshot.tasks : EMPTY_TASKS,
    listId: snapshot?.scope.listId ?? listId,
    refreshGoogleTasks,
  };
}
