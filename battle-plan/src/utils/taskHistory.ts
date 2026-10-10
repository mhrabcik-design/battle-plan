import type { Task } from '../db';
import { calendarTaskOverlapsWeek } from './calendarPresentation.ts';

export const isTaskVisibleInWeek = (task: Task, start: string, end: string): boolean => {
    if (task.isDeleted || task.calendar?.recurringMaster || task.type === 'thought' || task.type === 'note') return false;
    if (task.calendar?.timing) return calendarTaskOverlapsWeek(task, start, end);
    if (calendarTaskOverlapsWeek(task, start, end)) return true;
    const scheduledDate = task.type === 'task' ? task.deadline : task.date;
    return !!scheduledDate && scheduledDate >= start && scheduledDate <= end;
};
