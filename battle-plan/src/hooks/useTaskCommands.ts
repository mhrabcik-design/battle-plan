import { useCallback } from 'react';
import { db, type Task } from '../db';
import { googleService } from '../services/googleService';
import { applySemanticResult } from '../services/semanticEngine';
import type { GoogleAuthStatus, GoogleTaskRaw, UnifiedTask } from '../types';

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

    await db.tasks.update(task.id, {
      subTasks: newSubTasks,
      progress: newProgress,
      duration: newDuration,
      totalDuration: total,
      updatedAt: Date.now()
    });
  }, []);

  const handleToggleTask = useCallback(async (task: UnifiedTask) => {
    if (task.isGoogleTask && task.googleId && googleAuth.isSignedIn) {
      const newStatus = task.status === 'completed' ? 'needsAction' : 'completed';
      await googleService.updateGoogleTask(task.googleId, { status: newStatus }, task.googleListId);
      refreshGoogleTasks();
    } else if (task.id) {
      const newStatus = task.status === 'completed' ? 'pending' : 'completed';
      await db.tasks.update(task.id, {
        status: newStatus,
        updatedAt: Date.now()
      });

      if (task.googleEventId && googleAuth.isSignedIn) {
        try {
          const updatedTask = { ...task, status: newStatus };
          await googleService.addToCalendar(updatedTask);
        } catch (e) {
          console.error("Failed to update calendar event on toggle", e);
        }
      }
    }
  }, [googleAuth.isSignedIn, refreshGoogleTasks]);

  const handleDeleteTask = useCallback(async (task: UnifiedTask) => {
    if (!confirm('Opravdu smazat tento záznam?')) return;

    if (task.isGoogleTask && task.googleId && googleAuth.isSignedIn) {
      await googleService.deleteGoogleTask(task.googleId, task.googleListId);
      refreshGoogleTasks();
    } else if (task.id) {
      if (task.googleEventId && googleAuth.isSignedIn) {
        try { await googleService.deleteFromCalendar(task.googleEventId); } catch { /* already deleted */ }
      }
      await db.tasks.update(task.id, { isDeleted: true, updatedAt: Date.now() });
    }
  }, [googleAuth.isSignedIn, refreshGoogleTasks]);

  const handleSaveEdit = useCallback(async () => {
    if (editingTask) {
      if (editingTask.isGoogleTask && editingTask.googleId && googleAuth.isSignedIn) {
        await googleService.updateGoogleTask(editingTask.googleId, {
          title: editingTask.title,
          notes: editingTask.description
        }, editingTask.googleListId);
        refreshGoogleTasks();
      } else if (editingTask.id) {
        const taskData = { ...editingTask };
        delete (taskData as Partial<UnifiedTask>).isGoogleTask;
        delete (taskData as Partial<UnifiedTask>).googleId;
        delete (taskData as Partial<UnifiedTask>).googleListId;
        await db.tasks.update(editingTask.id, { ...taskData, updatedAt: Date.now() });
        if (editingTask.type === 'meeting' && googleAuth.isSignedIn) {
          try {
            const eventId = await googleService.addToCalendar(editingTask);
            if (eventId && eventId !== editingTask.googleEventId) {
              await db.tasks.update(editingTask.id, { googleEventId: eventId, updatedAt: Date.now() });
            }
          } catch (e) {
            console.error("Save Google sync failed", e);
          }
        }
      }
      setEditingTask(null);
    }
  }, [editingTask, googleAuth.isSignedIn, refreshGoogleTasks, setEditingTask]);

  const handleSyncToGoogle = useCallback(async (task: UnifiedTask) => {
    if (!task.id || !googleAuth.isSignedIn) {
      alert("Pro synchronizaci musíte být přihlášeni ke Googlu.");
      return;
    }
    setIsProcessing(true);
    try {
      const eventId = await googleService.addToCalendar(task);
      if (eventId) {
        await db.tasks.update(task.id, { googleEventId: eventId, updatedAt: Date.now() });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(msg || "Chyba při synchronizaci s Googlem");
    } finally {
      setIsProcessing(false);
    }
  }, [googleAuth.isSignedIn, setIsProcessing]);

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
