import type { BattlePlanDB, Task } from '../db.ts';
import type { WeeklySchedulePatch } from '../utils/calendarUtils.ts';

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
): Promise<{ before: Task; after: Task } | null> {
    return database.transaction('rw', database.tasks, async () => {
        const before = await database.tasks.get(id);
        if (!before || before.isDeleted) return null;
        if (expected && (before.type !== expected.type || before.publicId !== expected.publicId
            || JSON.stringify(getSchedule(before)) !== JSON.stringify(getSchedule(expected)))) return null;
        const after = { ...before, ...patch, updatedAt: Date.now() };
        await database.tasks.update(id, { ...patch, updatedAt: after.updatedAt });
        return { before, after };
    });
}
