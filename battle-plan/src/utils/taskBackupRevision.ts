import { db, type Setting, type Task } from '../db.ts';
import { filterTaskBackupSettings, TASK_BACKUP_SETTING_IDS } from './taskBackupSettings.ts';
import { canonicalBackupJson } from './canonicalBackupJson.ts';

export function readTaskBackupSnapshot() {
    return db.transaction('r', db.tasks, db.settings, async () => {
        const [tasks, settings] = await Promise.all([
            db.tasks.toArray(), db.settings.where('id').anyOf(TASK_BACKUP_SETTING_IDS).toArray(),
        ]);
        const portableSettings = filterTaskBackupSettings(settings);
        return { revision: taskBackupRevision(tasks, portableSettings), data: { tasks, settings: portableSettings } };
    });
}

/** Include every backed-up field, including edits that did not bump updatedAt. */
export function taskBackupRevision(tasks: readonly Task[], settings: readonly Setting[]): string {
    return canonicalBackupJson([
        [...tasks].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
        [...settings].sort((a, b) => a.id.localeCompare(b.id)),
    ]);
}
