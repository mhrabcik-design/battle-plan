import type { UnifiedTask, ViewMode } from '../types.ts';
import { toLocalIsoDate } from './monthCalendar.ts';

export type PlanningFilter = 'all' | 'today' | 'overdue' | 'undated';

const planningDate = (task: UnifiedTask) => task.type === 'meeting' ? task.date : task.deadline;
const normalizeSearch = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ').trim();

export function getPlanningSummary(tasks: readonly UnifiedTask[], today: string) {
  const counts = { all: 0, today: 0, overdue: 0, undated: 0 };
  for (const task of tasks) {
    if (task.isDeleted || task.status !== 'pending') continue;
    counts.all++;
    const date = planningDate(task);
    if (!date) counts.undated++;
    else if (date === today) counts.today++;
    else if (date < today) counts.overdue++;
  }
  return counts;
}

export function filterPlanningTasks(tasks: readonly UnifiedTask[], query: string, filter: PlanningFilter, today: string) {
  const needle = normalizeSearch(query);
  return tasks.filter(task => {
    if (task.isDeleted) return false;
    if (filter !== 'all') {
      if (task.status !== 'pending') return false;
      const date = planningDate(task);
      if (filter === 'today' && date !== today) return false;
      if (filter === 'overdue' && (!date || date >= today)) return false;
      if (filter === 'undated' && date) return false;
    }
    return !needle || normalizeSearch([task.title, task.description, ...(task.subTasks ?? []).map(subtask => subtask.title)].join(' ')).includes(needle);
  });
}

export function createTaskDraft(view: ViewMode, now = new Date()): UnifiedTask {
  return {
    title: '', description: '', type: view === 'meetings' ? 'meeting' : view === 'thoughts' ? 'thought' : 'task',
    date: view === 'meetings' ? toLocalIsoDate(now) : undefined,
    urgency: 2, status: 'pending', progress: 0, subTasks: [],
    createdAt: now.getTime(), updatedAt: now.getTime(),
  };
}
