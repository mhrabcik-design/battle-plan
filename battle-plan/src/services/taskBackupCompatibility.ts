import type { Task } from '../db.ts';

/** Only known historical values; malformed current data must still fail validation. */
export function normalizeLegacyBackupTask(task: Task): Task {
    const type: string = task.type;
    const urgency: number = task.urgency;
    const legacyType = type === 'followup' || type === 'reminder';
    const legacyUrgency = urgency === 4 || urgency === 5;
    if (!legacyType && !legacyUrgency) return task;
    return {
        ...task,
        type: legacyType ? 'task' : task.type,
        urgency: legacyUrgency ? 3 : task.urgency,
    };
}
