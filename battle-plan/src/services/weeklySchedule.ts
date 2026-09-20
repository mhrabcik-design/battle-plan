import type { BattlePlanDB, Task } from '../db.ts';
import type { WeeklySchedulePatch } from '../utils/calendarUtils.ts';
import { calendarEffectsForLocalTask, newTaskMutationContext, TaskMutationService, taskMutationTables, type TaskMutationContext } from './taskMutations.ts';

export const getSchedule = (task: Task): WeeklySchedulePatch => ({
    date: task.date,
    deadline: task.deadline,
    startTime: task.startTime,
    isAllDay: task.isAllDay,
    duration: task.duration,
});

export async function saveWeeklySchedule(
    database: BattlePlanDB,
    id: number,
    patch: WeeklySchedulePatch,
    expected?: Task,
    options: { publicId?: string; context?: TaskMutationContext } = {},
): Promise<{ before: Task; after: Task; effectIds: string[] } | null> {
    return database.transaction('rw', taskMutationTables(database), async () => {
        const before = await database.tasks.get(id);
        if (!before || before.isDeleted) return null;
        if (options.publicId && options.publicId !== before.publicId) return null;
        if (expected && (before.type !== expected.type || before.publicId !== expected.publicId
            || JSON.stringify(getSchedule(before)) !== JSON.stringify(getSchedule(expected)))) return null;
        const result = await new TaskMutationService(database).updateTask({
            localId: id,
            publicId: before.publicId,
            changes: patch,
            context: options.context ?? newTaskMutationContext('ui'),
            effects: calendarEffectsForLocalTask(before, 'upsert'),
        });
        return result.status === 'applied' ? { before, after: result.task, effectIds: result.effectIds } : null;
    });
}
