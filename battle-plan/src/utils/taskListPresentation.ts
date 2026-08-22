import type { UnifiedTask, ViewMode } from '../types';

export const COMPLETED_TASK_CARD_CLASSES = 'border-emerald-500/35 bg-emerald-950/25 opacity-80 shadow-[inset_0_1px_0_rgba(16,185,129,0.12)]';
export const COMPLETED_TASK_TITLE_CLASSES = 'text-emerald-200 line-through decoration-emerald-500/60';
export const LEGACY_COMPLETED_CARD_CLASSES = 'opacity-50 grayscale-[0.3]';
export const ACTIVE_TASK_TITLE_CLASSES = 'text-white group-hover:text-indigo-400';

export type TaskVisualTone = 'task' | 'meeting' | 'completed' | 'danger';

export interface CompletedItemVisibility {
    tasks: boolean;
    meetings: boolean;
}

const DEFAULT_COMPLETED_ITEM_VISIBILITY: CompletedItemVisibility = {
    tasks: false,
    meetings: false,
};

export function getTaskVisualTone<T extends Pick<UnifiedTask, 'type' | 'status'>>(
    task: T,
    overCapacity: boolean,
): TaskVisualTone {
    if (overCapacity) return 'danger';
    if (task.status === 'completed') return 'completed';
    return task.type === 'meeting' ? 'meeting' : 'task';
}

export function getTaskListPresentation<T extends Pick<UnifiedTask, 'status'>>(
    tasks: readonly T[],
    showCompleted = false,
): { completedTaskCount: number; visibleTasks: readonly T[] } {
    let completedTaskCount = 0;
    const activeTasks: T[] = [];

    for (const task of tasks) {
        if (task.status === 'completed') completedTaskCount += 1;
        else if (!showCompleted) activeTasks.push(task);
    }

    return {
        completedTaskCount,
        visibleTasks: showCompleted ? tasks : activeTasks,
    };
}

export function getTaskGridPresentation<T extends Pick<UnifiedTask, 'status'>>(
    tasks: readonly T[],
    viewMode: ViewMode,
    completedVisibility: CompletedItemVisibility = DEFAULT_COMPLETED_ITEM_VISIBILITY,
): { completedTaskCount: number; visibleTasks: readonly T[] } {
    if (viewMode === 'tasks') {
        return getTaskListPresentation(tasks, completedVisibility.tasks);
    }

    if (viewMode === 'meetings') {
        return getTaskListPresentation(tasks, completedVisibility.meetings);
    }

    return { completedTaskCount: 0, visibleTasks: tasks };
}

export function getTaskCompletionClasses(isCompleted: boolean, useCompletedTaskTreatment: boolean) {
    if (!isCompleted) {
        return { card: '', title: ACTIVE_TASK_TITLE_CLASSES };
    }

    return useCompletedTaskTreatment
        ? { card: COMPLETED_TASK_CARD_CLASSES, title: COMPLETED_TASK_TITLE_CLASSES }
        : { card: LEGACY_COMPLETED_CARD_CLASSES, title: ACTIVE_TASK_TITLE_CLASSES };
}

export function sortTasksActiveFirst<T extends Pick<UnifiedTask, 'status' | 'urgency'>>(
    tasks: readonly T[],
): T[] {
    return [...tasks].sort((a, b) => {
        const statusDifference = Number(a.status === 'completed') - Number(b.status === 'completed');
        if (statusDifference !== 0) return statusDifference;
        return (b.urgency || 0) - (a.urgency || 0);
    });
}
