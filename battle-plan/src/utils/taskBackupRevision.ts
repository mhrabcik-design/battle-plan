import { db, type Setting, type Task } from '../db.ts';

export function readTaskBackupSnapshot() {
    return db.transaction('r', db.tasks, db.settings, async () => {
        const [tasks, settings] = await Promise.all([db.tasks.toArray(), db.settings.toArray()]);
        return { revision: taskBackupRevision(tasks, settings), data: { tasks, settings } };
    });
}

/** Include every backed-up field, including edits that did not bump updatedAt. */
export function taskBackupRevision(tasks: readonly Task[], settings: readonly Setting[]): string {
    return JSON.stringify([
        [...tasks].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
        [...settings].sort((a, b) => a.id.localeCompare(b.id)),
    ], (_key, value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    });
}
