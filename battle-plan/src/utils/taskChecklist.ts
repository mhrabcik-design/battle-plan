import type { Task } from '../db.ts';

type ChecklistTask = Pick<Task, 'subTasks' | 'progress' | 'duration' | 'totalDuration'>;

/** Reconcile author edits without rewriting manual progress on unrelated saves. */
export function reconcileTaskChecklist(task: ChecklistTask, previous?: ChecklistTask): Partial<ChecklistTask> {
    const steps = task.subTasks ?? [];
    const previousSteps = previous?.subTasks ?? [];
    const durationChanged = previous !== undefined && task.duration !== previous.duration;
    if (!steps.length && !previousSteps.length) return durationChanged ? { totalDuration: task.duration } : {};
    const checklistState = (items: typeof steps) => items.map(item => [item.id, item.completed]);
    const checklistChanged = !previous || JSON.stringify(checklistState(steps)) !== JSON.stringify(checklistState(previousSteps));
    if (!checklistChanged && !durationChanged) return {};

    const progress = steps.length ? Math.round(steps.filter(step => step.completed).length / steps.length * 100) : 0;
    const remaining = 1 - progress / 100;
    // A manually entered duration is remaining work. Rebase its total so later
    // checkbox changes do not restore an obsolete estimate.
    const totalDuration = durationChanged
        ? task.duration === undefined ? undefined : remaining > 0 ? Math.round(task.duration / remaining) : task.duration
        : task.totalDuration ?? task.duration;
    const duration = durationChanged ? task.duration
        : totalDuration === undefined ? undefined : Math.round(totalDuration * remaining);
    return { progress, totalDuration, duration };
}
