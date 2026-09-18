import { db, type Task } from '../db.ts';
import { taskBackupRevision } from '../utils/taskBackupRevision.ts';

async function portableTask(task: Task): Promise<Task> {
    if (task.publicId) return task;
    // Legacy data has no provable identity across edits. Preserve ambiguous
    // snapshots separately; identical imports still converge on every device.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(taskBackupRevision([task], [])));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { ...task, publicId: `task_legacy_${hex}` };
}

export async function mergeTasksFromDrive(tasks: Task[]): Promise<boolean> {
    // Hash before entering IndexedDB: awaiting WebCrypto inside a transaction
    // lets the browser close that transaction before the following write.
    const portableTasks = await Promise.all(tasks.map(portableTask));
    let changed = false;
    await db.transaction('rw', db.tasks, async () => {
        for (const cloudTask of portableTasks) {
            const [byPublicId, byOccurrence] = await Promise.all([
                db.tasks.where('publicId').equals(cloudTask.publicId!).first(),
                cloudTask.suggestionOccurrenceKey
                    ? db.tasks.where('suggestionOccurrenceKey').equals(cloudTask.suggestionOccurrenceKey).first()
                    : undefined,
            ]);
            if (byPublicId && byOccurrence && byPublicId.id !== byOccurrence.id) {
                throw new Error('Konflikt identity návrhu: publicId a occurrence odkazují na různé úkoly.');
            }
            // Independent conversion of one occurrence gets a different random
            // publicId on each device. The occurrence still identifies one task.
            const localTask = byPublicId ?? byOccurrence;
            if (localTask?.suggestionSubjectId && cloudTask.suggestionSubjectId
                && localTask.suggestionSubjectId !== cloudTask.suggestionSubjectId) {
                throw new Error('Konflikt identity návrhu: shodný úkol má různé subject identity.');
            }
            if (localTask?.suggestionOccurrenceKey && cloudTask.suggestionOccurrenceKey
                && localTask.suggestionOccurrenceKey !== cloudTask.suggestionOccurrenceKey) {
                throw new Error('Konflikt identity návrhu: shodný úkol má různé occurrence identity.');
            }
            if (!localTask) {
                const incoming = { ...cloudTask };
                delete incoming.id;
                await db.tasks.add(incoming);
                changed = true;
            } else if ((cloudTask.updatedAt || cloudTask.createdAt || 0) > (localTask.updatedAt || localTask.createdAt || 0)) {
                await db.tasks.put({
                    ...cloudTask,
                    id: localTask.id,
                    publicId: localTask.publicId,
                    suggestionOccurrenceKey: localTask.suggestionOccurrenceKey ?? cloudTask.suggestionOccurrenceKey,
                    suggestionSubjectId: localTask.suggestionSubjectId ?? cloudTask.suggestionSubjectId,
                });
                changed = true;
            }
        }
    });
    return changed;
}
