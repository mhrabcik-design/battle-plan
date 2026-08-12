import type { Task } from '../db';

export const isTaskVisibleInWeek = (task: Task, start: string, end: string): boolean => {
    if (task.isDeleted || task.type === 'thought' || task.type === 'note') return false;
    const scheduledDate = task.type === 'task' ? task.deadline : task.date;
    return !!scheduledDate && scheduledDate >= start && scheduledDate <= end;
};

export const isTaskCleanupCandidate = (task: Task, cutoff: number): boolean => {
    return !!task.isDeleted && (task.updatedAt || task.createdAt) < cutoff;
};
