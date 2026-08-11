import { useCallback } from 'react';
import type { Task } from '../db';
import { AuthUnavailableError, googleService } from '../services/googleService';
import { applySemanticResult } from '../services/semanticEngine';
import { drainGoogleExternalEffects } from '../services/externalEffectOutbox';
import { calendarEffectsForLocalTask, newTaskMutationContext, taskMutations } from '../services/taskMutations';
import type { GoogleAuthStatus, GoogleTaskRaw, UnifiedTask } from '../types';
import { hasUsableAuth } from '../types';

interface UseTaskCommandsArgs {
  googleAuth: GoogleAuthStatus;
  activeTaskList: string;
  editingTask: UnifiedTask | null;
  setEditingTask: (updater: UnifiedTask | null | ((prev: UnifiedTask | null) => UnifiedTask | null)) => void;
  setGoogleTasksRaw: (tasks: GoogleTaskRaw[]) => void;
  setIsProcessing: (isProcessing: boolean) => void;
}

export function useTaskCommands({
  googleAuth,
  activeTaskList,
  editingTask,
  setEditingTask,
  setGoogleTasksRaw,
  setIsProcessing,
}: UseTaskCommandsArgs) {
  // U3: surface auth-unavailable failures to the user. The hook-level
  // googleAuth may be stale (React setState is async; markAuthUnavailable
  // dispatches synchronously via google-auth-change but the consumer state
  // is captured at render time). Read live state from the singleton.
  const isAuthUnavailableNow = (): boolean => {
      const state = googleService.getAuthState();
      return state === 'OFFLINE_AUTH' || state === 'SIGNED_OUT';
  };
  const AUTH_UNAVAILABLE_MSG = 'Relace vypršela, obnovte prosím autorizaci v Nastavení';
  const refreshGoogleTasks = useCallback(() => {
    googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
  }, [activeTaskList, setGoogleTasksRaw]);

  const applyAiResult = useCallback(async (result: Partial<Task>, updateId: number | null) => {
    const semanticOutput = await applySemanticResult(result, updateId, googleAuth);
    if (!semanticOutput) return;

    if (updateId && semanticOutput.updatedId) {
      if (editingTask && editingTask.id === updateId) {
        setEditingTask(prev => prev ? { ...prev, ...semanticOutput.result } : null);
      }
    }
  }, [googleAuth, editingTask, setEditingTask]);

  const toggleSubtask = useCallback(async (task: UnifiedTask, subTaskId: string) => {
    if (!task.id || !task.subTasks) return;
    const newSubTasks = task.subTasks.map(st => st.id === subTaskId ? { ...st, completed: !st.completed } : st);
    const completedCount = newSubTasks.filter(st => st.completed).length;
    const newProgress = Math.round((completedCount / newSubTasks.length) * 100);
    const total = task.totalDuration || task.duration || 0;
    const newDuration = Math.round(total * (1 - newProgress / 100));

    await taskMutations.updateTask({
      localId: task.id,
      changes: { subTasks: newSubTasks, progress: newProgress, duration: newDuration, totalDuration: total },
      context: newTaskMutationContext('ui'),
    });
  }, []);

  const handleToggleTask = useCallback(async (task: UnifiedTask) => {
    if (task.isGoogleTask && task.googleId && hasUsableAuth(googleAuth)) {
      const newStatus = task.status === 'completed' ? 'needsAction' : 'completed';
      const result = await googleService.updateGoogleTask(task.googleId, { status: newStatus }, task.googleListId);
      if (result === null && isAuthUnavailableNow()) {
        alert(AUTH_UNAVAILABLE_MSG);
      }
      refreshGoogleTasks();
    } else if (task.id) {
      const newStatus = task.status === 'completed' ? 'pending' : 'completed';
      const calendarEffects = calendarEffectsForLocalTask(task, 'upsert');
      const mutation = newStatus === 'completed'
        ? await taskMutations.completeTask({
            localId: task.id,
            context: newTaskMutationContext('ui'),
            effects: calendarEffects,
          })
        : await taskMutations.updateTask({
            localId: task.id,
            changes: { status: newStatus },
            context: newTaskMutationContext('ui'),
            effects: calendarEffects,
          });

      if (mutation.status === 'applied' && mutation.effectIds.length && hasUsableAuth(googleAuth)) {
        const outcome = await drainGoogleExternalEffects(mutation.effectIds);
        if (outcome.retryScheduled || outcome.failed) {
          console.error('Failed to update calendar event on toggle; durable retry retained');
        }
      }
    }
  }, [googleAuth, refreshGoogleTasks]);

  const handleDeleteTask = useCallback(async (task: UnifiedTask) => {
    if (!confirm('Opravdu smazat tento záznam?')) return;

    if (task.isGoogleTask && task.googleId && hasUsableAuth(googleAuth)) {
      await googleService.deleteGoogleTask(task.googleId, task.googleListId);
      if (isAuthUnavailableNow()) {
        alert(AUTH_UNAVAILABLE_MSG);
      }
      refreshGoogleTasks();
    } else if (task.id) {
      const mutation = await taskMutations.archiveTask({
        localId: task.id,
        context: newTaskMutationContext('ui'),
        effects: calendarEffectsForLocalTask(task, 'delete'),
      });
      if (mutation.status === 'applied' && mutation.effectIds.length && hasUsableAuth(googleAuth)) {
        await drainGoogleExternalEffects(mutation.effectIds);
        if (isAuthUnavailableNow()) alert(AUTH_UNAVAILABLE_MSG);
      }
    }
  }, [googleAuth, refreshGoogleTasks]);

  const handleSaveEdit = useCallback(async () => {
    if (editingTask) {
      if (editingTask.isGoogleTask && editingTask.googleId && hasUsableAuth(googleAuth)) {
        const result = await googleService.updateGoogleTask(editingTask.googleId, {
          title: editingTask.title,
          notes: editingTask.description
        }, editingTask.googleListId);
        if (result === null && isAuthUnavailableNow()) {
          alert(AUTH_UNAVAILABLE_MSG);
        }
        refreshGoogleTasks();
      } else if (editingTask.id) {
        const taskData = { ...editingTask };
        delete (taskData as Partial<UnifiedTask>).isGoogleTask;
        delete (taskData as Partial<UnifiedTask>).googleId;
        delete (taskData as Partial<UnifiedTask>).googleListId;
        const mutation = await taskMutations.updateTask({
          localId: editingTask.id,
          changes: taskData,
          context: newTaskMutationContext('ui'),
          effects: calendarEffectsForLocalTask(editingTask, 'upsert', hasUsableAuth(googleAuth)),
        });
        if (mutation.status === 'applied' && mutation.effectIds.length && hasUsableAuth(googleAuth)) {
          const outcome = await drainGoogleExternalEffects(mutation.effectIds);
          if (outcome.retryScheduled || outcome.failed) console.error('Save Google sync failed; durable retry retained');
          if (isAuthUnavailableNow()) alert(AUTH_UNAVAILABLE_MSG);
        }
      }
      setEditingTask(null);
    }
  }, [editingTask, googleAuth, refreshGoogleTasks, setEditingTask]);

  const handleSyncToGoogle = useCallback(async (task: UnifiedTask) => {
    if (!task.id || !hasUsableAuth(googleAuth)) {
      return;
    }
    setIsProcessing(true);
    try {
      const queued = await taskMutations.queueEffects({
        localId: task.id,
        context: newTaskMutationContext('ui'),
        effects: [{ kind: 'calendar', operation: 'upsert' }],
      });
      if (queued.status === 'queued') {
        const outcome = await drainGoogleExternalEffects(queued.effectIds);
        if (outcome.retryScheduled || outcome.failed) alert('Synchronizaci se nepodařilo dokončit; bude automaticky opakována.');
      }
    } catch (err: unknown) {
      if (err instanceof AuthUnavailableError) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg || "Chyba při synchronizaci s Googlem");
    } finally {
      setIsProcessing(false);
    }
  }, [googleAuth, setIsProcessing]);

  const handleExport = useCallback((task: UnifiedTask) => {
    const subTasksText = (task.subTasks || []).map(st => `${st.completed ? '✅' : '☐'} ${st.title}`).join('\n');
    const body = `=== ${task.title} ===\nTermín: ${task.deadline || task.date || 'Neurčeno'} | Urgence: ${task.urgency}/3\nPokrok: ${task.progress || 0}%\n--------------------------------------\nPOPIS:\n${task.description || 'Bez popisu'}\n\n${subTasksText ? `PŘEHLED PODÚKOLŮ:\n${subTasksText}\n` : ''}INTERNÍ ZÁPIS:\n${task.internalNotes || 'Bez dodatečného zápisu'}\n\n--\nOdesláno z aplikace Bitevní Plán`.trim();
    const subject = `${task.title} [BP]`;
    const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailtoUrl;
  }, []);

  return {
    applyAiResult,
    toggleSubtask,
    handleToggleTask,
    handleDeleteTask,
    handleSaveEdit,
    handleSyncToGoogle,
    handleExport,
  };
}
