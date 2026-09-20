import { db, type Task } from '../db.ts';
import { taskBackupRevision } from '../utils/taskBackupRevision.ts';
import { newTaskMutationContext, taskMutations, taskMutationTables } from './taskMutations.ts';

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
    const portableTasks = await Promise.all(structuredClone(tasks).map(portableTask));
    let changed = false;
    await db.transaction('rw', taskMutationTables(db), async () => {
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
            const result = await taskMutations.importTask({
                task: cloudTask,
                localId: localTask?.id,
                context: newTaskMutationContext('drive'),
            });
            if (result.status === 'applied') changed = true;
            else if (result.status !== 'unchanged') throw new Error(`Task import failed: ${result.status}`);
        }
    });
    return changed;
}
