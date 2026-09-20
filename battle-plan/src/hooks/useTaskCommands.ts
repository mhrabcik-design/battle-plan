import { useCallback, useRef, useState } from 'react';
import { db, type Task } from '../db.ts';
import { googleService } from '../services/googleService.ts';
import { applySemanticResult } from '../services/semanticEngine.ts';
import type { GoogleAuthStatus, GoogleTaskRaw, UnifiedTask } from '../types.ts';
import { hasUsableAuth, isAuthUnavailable } from '../types.ts';
import type { WeeklySchedulePatch } from '../utils/calendarUtils.ts';
import { getSchedule, saveWeeklySchedule } from '../services/weeklySchedule.ts';
import { ensureTaskDeadline } from '../services/taskNormalization.ts';
import { calendarEffectsForLocalTask, newTaskMutationContext, taskMutations, taskMutationTables, type TaskEffectRequest } from '../services/taskMutations.ts';
import { drainGoogleExternalEffects } from '../services/externalEffectOutbox.ts';

const SYNC_PENDING_MSG = 'Změna je uložená lokálně, ale synchronizace s Googlem zatím není dokončená.';

async function deliverEffects(effectIds: readonly string[]): Promise<boolean> {
  if (!effectIds.length) return true;
  try {
    await drainGoogleExternalEffects(effectIds);
    const effects = await db.agentProtocolEffects.bulkGet([...effectIds]);
    return effects.every(effect => effect?.state === 'succeeded');
  } catch (error) {
    console.error('Task synchronization remains queued', error);
    return false;
  }
}

const uiMutationContext = () => newTaskMutationContext('ui', undefined, googleService.getAccountId() ?? undefined);

interface UseTaskCommandsArgs {
  googleAuth: GoogleAuthStatus;
  activeTaskList: string;
  editingTask: UnifiedTask | null;
  setEditingTask: (updater: UnifiedTask | null | ((prev: UnifiedTask | null) => UnifiedTask | null)) => void;
  setGoogleTasksRaw: (tasks: GoogleTaskRaw[]) => void;
  setIsProcessing: (isProcessing: boolean) => void;
}

export type EditorSaveOutcome =
  | { status: 'success' }
  | { status: 'success-sync-warning'; message: string }
  | { status: 'failed'; message: string };

export function useTaskCommands({
  googleAuth,
  activeTaskList,
  editingTask,
  setEditingTask,
  setGoogleTasksRaw,
  setIsProcessing,
}: UseTaskCommandsArgs) {
  const [lastScheduleChange, setLastScheduleChange] = useState<{ before: UnifiedTask; after: UnifiedTask } | null>(null);
  const [isScheduleBusy, setIsScheduleBusy] = useState(false);
  const scheduleBusyRef = useRef(false);
  const saveInFlightRef = useRef<Promise<EditorSaveOutcome> | null>(null);
  // U3: surface auth-unavailable failures to the user. The hook-level
  // googleAuth may be stale (React setState is async; markAuthUnavailable
  // dispatches synchronously via google-auth-change but the consumer state
  // is captured at render time). Read live state from the singleton.
  const isAuthUnavailableNow = (): boolean => {
      return isAuthUnavailable(googleService.getAuthState());
  };
  const AUTH_UNAVAILABLE_MSG = 'Relace vypršela, obnovte prosím autorizaci v Nastavení';
  const refreshGoogleTasks = useCallback(async () => {
    const tasks = await googleService.getTasks(activeTaskList);
    setGoogleTasksRaw(tasks);
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
    if (!task.id || task.isGoogleTask) return;
    const result = await db.transaction('rw', taskMutationTables(db), async () => {
      const current = await db.tasks.get(task.id!);
      if (!current || current.isDeleted || (task.publicId && task.publicId !== current.publicId)
        || !current.subTasks?.some(subtask => subtask.id === subTaskId)) return null;
      const subTasks = current.subTasks.map(st => st.id === subTaskId ? { ...st, completed: !st.completed } : st);
      const progress = Math.round(subTasks.filter(st => st.completed).length / subTasks.length * 100);
      const totalDuration = current.totalDuration || current.duration || 0;
      return taskMutations.updateTask({
        localId: current.id, publicId: current.publicId, context: uiMutationContext(),
        changes: { subTasks, progress, totalDuration, duration: Math.round(totalDuration * (1 - progress / 100)) },
        effects: calendarEffectsForLocalTask(current, 'upsert'),
      });
    });
    if (result?.status === 'applied') await deliverEffects(result.effectIds);
  }, []);

  const handleToggleTask = useCallback(async (task: UnifiedTask): Promise<UnifiedTask | null> => {
    if (task.isGoogleTask && task.googleId) {
      if (!hasUsableAuth(googleAuth)) {
        alert(AUTH_UNAVAILABLE_MSG);
        return null;
      }
      const newStatus = task.status === 'completed' ? 'needsAction' : 'completed';
      const result = await googleService.updateGoogleTask(task.googleId, { status: newStatus }, task.googleListId);
      if (result === null && isAuthUnavailableNow()) {
        alert(AUTH_UNAVAILABLE_MSG);
        return null;
      }
      if (result === null) return null;
      await refreshGoogleTasks();
      const status: UnifiedTask['status'] = newStatus === 'completed' ? 'completed' : 'pending';
      return { ...task, status, updatedAt: Date.now() };
    } else if (task.id) {
      const result = await db.transaction('rw', taskMutationTables(db), async () => {
        const current = await db.tasks.get(task.id!);
        if (!current || current.isDeleted || (task.publicId && task.publicId !== current.publicId)) return null;
        const status: Task['status'] = current.status === 'completed' ? 'pending' : 'completed';
        const effects: TaskEffectRequest[] = calendarEffectsForLocalTask(current, 'upsert');
        if (status === 'completed' && current.googleId) effects.push({ kind: 'google_tasks', operation: 'complete' });
        return taskMutations.updateTask({
          localId: current.id, publicId: current.publicId, changes: { status }, context: uiMutationContext(), effects,
        });
      });
      if (result?.status !== 'applied') return null;
      await deliverEffects(result.effectIds);
      return result.task;
    }
    return null;
  }, [googleAuth, refreshGoogleTasks]);

  const persistRescheduleTask = useCallback(async (task: UnifiedTask, patch: WeeklySchedulePatch, expected?: UnifiedTask) => {
    if (task.isGoogleTask && task.googleId) {
      if (!hasUsableAuth(googleAuth)) {
        alert(AUTH_UNAVAILABLE_MSG);
        return null;
      }
      const remote = (await googleService.getTasks(task.googleListId)).find(item => item.id === task.googleId);
      if (!remote || (expected && remote.due?.slice(0, 10) !== expected.deadline)) return null;
      const before = { ...task, date: remote.due?.slice(0, 10), deadline: remote.due?.slice(0, 10) };
      const result = await googleService.updateGoogleTask(task.googleId, {
        due: patch.deadline ? `${patch.deadline}T00:00:00.000Z` : null,
      }, task.googleListId);
      if (result === null) {
        if (isAuthUnavailableNow()) alert(AUTH_UNAVAILABLE_MSG);
        return null;
      }
      await refreshGoogleTasks();
      return { before, after: { ...before, ...patch } };
    }

    if (!task.id) return null;
    const change = await saveWeeklySchedule(db, task.id, patch, expected, { publicId: task.publicId, context: uiMutationContext() });
    if (!change) return null;
    if (!await deliverEffects(change.effectIds)) alert(SYNC_PENDING_MSG);
    return change;
  }, [googleAuth, refreshGoogleTasks]);

  const handleRescheduleTask = useCallback(async (task: UnifiedTask, patch: WeeklySchedulePatch) => {
    if (scheduleBusyRef.current) return false;
    scheduleBusyRef.current = true;
    setIsScheduleBusy(true);
    try {
      const change = await persistRescheduleTask(task, patch);
      if (!change) return false;
      setLastScheduleChange(change);
      return true;
    } finally {
      scheduleBusyRef.current = false;
      setIsScheduleBusy(false);
    }
  }, [persistRescheduleTask]);

  const handleUndoSchedule = useCallback(async () => {
    if (!lastScheduleChange || scheduleBusyRef.current) return;
    scheduleBusyRef.current = true;
    setIsScheduleBusy(true);
    try {
      const restored = await persistRescheduleTask(lastScheduleChange.after, getSchedule(lastScheduleChange.before), lastScheduleChange.after);
      if (restored) setLastScheduleChange(null);
      else alert('Změnu nelze vrátit: položka již není dostupná, její termín se mezitím změnil nebo se nepodařilo připojit ke Googlu.');
    } catch (error) {
      console.error('Weekly undo failed', error);
      alert('Vrácení změny se nepodařilo uložit. Zkuste to znovu.');
    } finally {
      scheduleBusyRef.current = false;
      setIsScheduleBusy(false);
    }
  }, [lastScheduleChange, persistRescheduleTask]);

  const handleDeleteTask = useCallback(async (task: UnifiedTask) => {
    if (!confirm('Opravdu smazat tento záznam?')) return false;

    if (task.isGoogleTask && task.googleId) {
      if (!hasUsableAuth(googleAuth)) {
        alert(AUTH_UNAVAILABLE_MSG);
        return false;
      }
      const deleted = await googleService.deleteGoogleTask(task.googleId, task.googleListId);
      if (!deleted) {
        if (isAuthUnavailableNow()) alert(AUTH_UNAVAILABLE_MSG);
        return false;
      }
      await refreshGoogleTasks();
    } else if (task.id) {
      const result = await db.transaction('rw', taskMutationTables(db), async () => {
        const current = await db.tasks.get(task.id!);
        if (!current || current.isDeleted || (task.publicId && task.publicId !== current.publicId)) return null;
        return taskMutations.archiveTask({
          localId: current.id, publicId: current.publicId, context: uiMutationContext(),
          effects: calendarEffectsForLocalTask(current, 'delete'),
        });
      });
      if (result?.status !== 'applied') return false;
      if (!await deliverEffects(result.effectIds)) alert(SYNC_PENDING_MSG);
    } else return false;
    return true;
  }, [googleAuth, refreshGoogleTasks]);

  const handleSaveEdit = useCallback((): Promise<EditorSaveOutcome> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const save = async (): Promise<EditorSaveOutcome> => {
      if (!editingTask) return { status: 'failed', message: 'Editor už není otevřený.' };
      const title = editingTask.title.trim();
      if (!title) return { status: 'failed', message: 'Doplňte název záznamu.' };
      const taskToSave = ensureTaskDeadline({ ...editingTask, title });
      if (editingTask.isGoogleTask) {
        if (!editingTask.googleId || !hasUsableAuth(googleAuth)) {
          return { status: 'failed', message: AUTH_UNAVAILABLE_MSG };
        }
        const result = await googleService.updateGoogleTask(editingTask.googleId, {
          title,
          notes: editingTask.description,
          due: taskToSave.deadline ? `${taskToSave.deadline}T00:00:00.000Z` : undefined,
        }, editingTask.googleListId);
        if (result === null && isAuthUnavailableNow()) {
          alert(AUTH_UNAVAILABLE_MSG);
        }
        if (result === null) return { status: 'failed', message: 'Google Task se nepodařilo uložit.' };
        void refreshGoogleTasks().catch(error => console.error('Google Tasks refresh failed after save', error));
      } else {
        const taskData = { ...taskToSave };
        delete (taskData as Partial<UnifiedTask>).isGoogleTask;
        const context = uiMutationContext();
        const allowUnlinkedCalendar = hasUsableAuth(googleAuth) && Boolean(context.googleAccountId);
        const result = await db.transaction('rw', taskMutationTables(db), async () => {
          if (taskData.id) {
            const current = await db.tasks.get(taskData.id);
            if (!current || current.isDeleted || (taskData.publicId && taskData.publicId !== current.publicId)) return null;
            return taskMutations.updateTask({
              localId: current.id, publicId: current.publicId, changes: taskData,
              expectedRevision: taskData.protocolRevision?.revision_id ?? null, context,
              effects: calendarEffectsForLocalTask({ ...current, type: taskData.type }, 'upsert', allowUnlinkedCalendar),
            });
          }
          return taskMutations.createTask({
            task: { ...taskData, source: 'user' }, context,
            effects: calendarEffectsForLocalTask(taskData, 'upsert', allowUnlinkedCalendar),
          });
        });
        if (result?.status === 'stale') return { status: 'failed', message: 'Záznam se mezitím změnil. Otevřete jej znovu; rozepsané změny nebyly uloženy.' };
        if (result?.status !== 'applied') return { status: 'failed', message: 'Záznam už není dostupný. Změny nebyly uloženy.' };
        if (!await deliverEffects(result.effectIds)) return { status: 'success-sync-warning', message: SYNC_PENDING_MSG };
      }
      return { status: 'success' };
    };
    const operation = save().finally(() => { saveInFlightRef.current = null; });
    saveInFlightRef.current = operation;
    return operation;
  }, [editingTask, googleAuth, refreshGoogleTasks]);

  const handleSyncToGoogle = useCallback(async (task: UnifiedTask) => {
    if (!task.id || task.isGoogleTask) {
      return;
    }
    setIsProcessing(true);
    try {
      const result = await taskMutations.queueEffects({
        localId: task.id, publicId: task.publicId, context: uiMutationContext(),
        effects: [{ kind: 'calendar', operation: 'upsert' }],
      });
      if (result.status === 'queued' && !await deliverEffects(result.effectIds)) alert(SYNC_PENDING_MSG);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg || "Chyba při synchronizaci s Googlem");
    } finally {
      setIsProcessing(false);
    }
  }, [setIsProcessing]);

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
    handleRescheduleTask,
    handleUndoSchedule,
    canUndoSchedule: lastScheduleChange !== null && !isScheduleBusy,
    handleDeleteTask,
    handleSaveEdit,
    handleSyncToGoogle,
    handleExport,
  };
}
