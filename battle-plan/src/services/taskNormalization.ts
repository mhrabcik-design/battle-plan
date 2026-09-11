import type { Task } from '../db';
import { toLocalIsoDate } from '../utils/monthCalendar.ts';

const validTaskDate = (value: unknown): value is string => (
    typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && toLocalIsoDate(new Date(`${value}T12:00:00`)) === value
);

/** Keep saved tasks visible in the Monday–Sunday week, including weekend capture. */
export function ensureTaskDeadline<T extends Partial<Task>>(
    task: T, now = new Date(),
): Omit<T, 'date' | 'deadline'> & Pick<Task, 'date' | 'deadline'> {
    if (task.type !== 'task') return task;
    const friday = new Date(now);
    friday.setDate(friday.getDate() + 5 - (friday.getDay() || 7));
    const deadline = validTaskDate(task.deadline) ? task.deadline
        : validTaskDate(task.date) ? task.date : toLocalIsoDate(friday);
    return { ...task, deadline, date: validTaskDate(task.date) ? task.date : deadline };
}

// Type and clamp helpers extracted from semanticEngine.ts so the same
// safety-net code can be reused by the agent write path and the voice
// path. The high-level rules (Czech synonym map, urgency default 2,
// startTime by type) live in the AI system prompt under
// "## ⚙️ SANITIZAČNÍ PRAVIDLA". These helpers round values the AI may
// have mis-typed, but they do not override correct values.

export const EXACT_TYPE_MAP: Record<string, Task['type']> = {
    'task': 'task',
    'úkol': 'task',
    'meeting': 'meeting',
    'sraz': 'meeting',
    'schůzka': 'meeting',
    'thought': 'thought',
    'myšlenka': 'thought',
    'note': 'thought',
};

export function normalizeType(aiType: string | undefined | null): Task['type'] {
    if (aiType == null) return 'thought';
    const lower = aiType.toLowerCase().trim();

    if (EXACT_TYPE_MAP[lower]) return EXACT_TYPE_MAP[lower];

    if (lower === 'task' || lower.includes('úkol')) return 'task';
    if (lower === 'meeting' || lower.includes('sraz') || lower.includes('schůzka')) return 'meeting';
    if (lower === 'thought' || lower.includes('myšlenka') || lower === 'note') return 'thought';

    return 'thought';
}

export function clampUrgency(val: unknown): 1 | 2 | 3 {
    const n = Number(val);
    if (isNaN(n)) return 2;
    return Math.min(3, Math.max(1, n)) as 1 | 2 | 3;
}

export function clampIsAllDay(val: unknown): boolean {
    if (val === true || val === 'true') return true;
    if (val === false || val === 'false') return false;
    return false;
}

export function clampProgress(val: unknown): number {
    const n = Number(val);
    if (isNaN(n)) return 0;
    return Math.min(100, Math.max(0, Math.round(n)));
}
