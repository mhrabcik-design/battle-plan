import { useCallback } from 'react';
import { db, type Task } from '../db';
import { AuthUnavailableError, googleService } from '../services/googleService';
import { applySemanticResult } from '../services/semanticEngine';
import type { GoogleAuthStatus, GoogleTaskRaw, UnifiedTask } from '../types';
import { hasUsableAuth, isAuthUnavailable } from '../types';
import type { WeeklySchedulePatch } from '../utils/calendarUtils';

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
    if (!task.id || !task.subTasks) return;
    const newSubTasks = task.subTasks.map(st => st.id === subTaskId ? { ...st, completed: !st.completed } : st);
    const completedCount = newSubTasks.filter(st => st.completed).length;
    const newProgress = Math.round((completedCount / newSubTasks.length) * 100);
    const total = task.totalDuration || task.duration || 0;
    const newDuration = Math.round(total * (1 - newProgress / 100));

    await db.tasks.update(task.id, {
      subTasks: newSubTasks,
      progress: newProgress,
      duration: newDuration,
      totalDuration: total,
      updatedAt: Date.now()
    });
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
      const newStatus = task.status === 'completed' ? 'pending' : 'completed';
      const updatedAt = Date.now();
      await db.tasks.update(task.id, {
        status: newStatus,
        updatedAt
      });

      if (task.googleEventId && hasUsableAuth(googleAuth)) {
        try {
          const updatedTask = { ...task, status: newStatus };
          await googleService.addToCalendar(updatedTask);
        } catch (e) {
          console.error("Failed to update calendar event on toggle", e);
        }
      }
      return { ...task, status: newStatus as UnifiedTask['status'], updatedAt };
    }
    return null;
  }, [googleAuth, refreshGoogleTasks]);

  const handleRescheduleTask = useCallback(async (task: UnifiedTask, patch: WeeklySchedulePatch) => {
    if (task.isGoogleTask && task.googleId) {
      if (!hasUsableAuth(googleAuth)) {
        alert(AUTH_UNAVAILABLE_MSG);
        return false;
      }
      const result = await googleService.updateGoogleTask(task.googleId, {
        due: `${patch.deadline}T00:00:00.000Z`,
      }, task.googleListId);
      if (result === null) {
        if (isAuthUnavailableNow()) alert(AUTH_UNAVAILABLE_MSG);
        return false;
      }
      await refreshGoogleTasks();
      return true;
    }

    if (!task.id) return false;
    const updatedTask = { ...task, ...patch, updatedAt: Date.now() };
    await db.tasks.update(task.id, { ...patch, updatedAt: updatedTask.updatedAt });

    if (task.type === 'meeting' && task.googleEventId && hasUsableAuth(googleAuth)) {
      const reportSyncFailure = (error?: unknown) => {
        if (error) console.error('Calendar reschedule sync failed', error);
        alert('Změna je uložená lokálně, ale synchronizace s Google Kalendářem selhala.');
      };
      try {
        const eventId = await googleService.addToCalendar(updatedTask);
        if (!eventId) reportSyncFailure();
      } catch (error) {
        reportSyncFailure(error);
      }
    }
    return true;
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
      if (task.googleEventId && hasUsableAuth(googleAuth)) {
        try { await googleService.deleteFromCalendar(task.googleEventId); } catch { /* already deleted */ }
        if (isAuthUnavailableNow()) {
          alert(AUTH_UNAVAILABLE_MSG);
        }
      }
      await db.tasks.update(task.id, { isDeleted: true, updatedAt: Date.now() });
    }
  }, [googleAuth, refreshGoogleTasks]);

  const handleSaveEdit = useCallback(async () => {
    if (editingTask) {
      if (editingTask.isGoogleTask && editingTask.googleId && hasUsableAuth(googleAuth)) {
        const result = await googleService.updateGoogleTask(editingTask.googleId, {
          title: editingTask.title,
          notes: editingTask.description,
          due: editingTask.deadline ? `${editingTask.deadline}T00:00:00.000Z` : undefined,
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
        await db.tasks.update(editingTask.id, { ...taskData, updatedAt: Date.now() });
        if (editingTask.type === 'meeting' && hasUsableAuth(googleAuth)) {
          try {
            const eventId = await googleService.addToCalendar(editingTask);
            if (eventId && eventId !== editingTask.googleEventId) {
              await db.tasks.update(editingTask.id, { googleEventId: eventId, updatedAt: Date.now() });
            }
            if (!eventId && isAuthUnavailableNow()) {
              alert(AUTH_UNAVAILABLE_MSG);
            }
          } catch (e) {
            console.error("Save Google sync failed", e);
          }
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
      const eventId = await googleService.addToCalendar(task);
      if (eventId) {
        await db.tasks.update(task.id, { googleEventId: eventId, updatedAt: Date.now() });
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
    handleRescheduleTask,
    handleDeleteTask,
    handleSaveEdit,
    handleSyncToGoogle,
    handleExport,
  };
}
