import type { Task, Setting } from '../db.ts';
import type { TaskDriveBackupPayload } from './taskDriveBackup.ts';
import { filterTaskBackupSettings } from '../utils/taskBackupSettings.ts';
import { canonicalBackupJson } from '../utils/canonicalBackupJson.ts';

function version(task: Task): number { return task.updatedAt || task.createdAt || 0; }

function content(task: Task): string {
    const copy: Partial<Task> = { ...task };
    delete copy.id;
    delete copy.publicId;
    delete copy.protocolRevision;
    delete copy.effectSequence;
    // Imports preserve the original device's creation time for an occurrence.
    delete copy.createdAt;
    copy.updatedAt = version(task);
    // These links describe this device's delivery state, not the task edit.
    delete copy.googleEventId;
    delete copy.reservedGoogleEventId;
    delete copy.googleId;
    delete copy.googleListId;
    delete copy.googleAccountId;
    copy.isDeleted = Boolean(copy.isDeleted);
    return canonicalBackupJson(copy);
}

/** Union all publications, never interpreting absence in a snapshot as deletion. */
export function mergeTaskBackupSnapshots(snapshots: readonly TaskDriveBackupPayload[]): TaskDriveBackupPayload {
    const groups = new Map<string, Task[]>();
    const settings = new Map<string, { timestamp: number; setting: Setting }>();
    let timestamp = 0;
    for (const snapshot of snapshots) {
        if (!snapshot || typeof snapshot !== 'object' || !snapshot.data || typeof snapshot.data !== 'object'
            || (snapshot.data.tasks !== undefined && !Array.isArray(snapshot.data.tasks))
            || (snapshot.data.settings !== undefined && !Array.isArray(snapshot.data.settings))
            || (snapshot.timestamp !== undefined && (!Number.isFinite(snapshot.timestamp) || snapshot.timestamp < 0))) {
            throw new Error('Neplatný formát zálohy úkolů.');
        }
        timestamp = Math.max(timestamp, snapshot.timestamp ?? 0);
        for (const task of snapshot.data.tasks ?? []) {
            if (!task || typeof task.title !== 'string'
                || (task.createdAt !== undefined && (!Number.isFinite(task.createdAt) || task.createdAt < 0))
                || (task.updatedAt !== undefined && (!Number.isFinite(task.updatedAt) || task.updatedAt < 0))
                || !['task', 'meeting', 'note', 'thought'].includes(task.type)
                || !['pending', 'completed', 'cancelled'].includes(task.status)
                || ![1, 2, 3].includes(task.urgency)
                || (task.isDeleted !== undefined && typeof task.isDeleted !== 'boolean')
                || (task.publicId !== undefined && (typeof task.publicId !== 'string' || !task.publicId))
                || (task.suggestionOccurrenceKey !== undefined && (typeof task.suggestionOccurrenceKey !== 'string' || !task.suggestionOccurrenceKey))
                || (task.suggestionSubjectId !== undefined && (typeof task.suggestionSubjectId !== 'string' || !task.suggestionSubjectId))) {
                throw new Error('Neplatný úkol v záloze.');
            }
            const keys = [
                task.publicId ? `public:${task.publicId}` : '',
                task.suggestionOccurrenceKey ? `occurrence:${task.suggestionOccurrenceKey}` : '',
            ].filter(Boolean);
            // Preserve legacy ambiguity exactly as taskMerge's content hashing does.
            if (!keys.length) keys.push(`legacy:${canonicalBackupJson(task)}`);
            const connected = new Set(keys.map(key => groups.get(key)).filter((group): group is Task[] => Boolean(group)));
            const group = connected.size === 1 ? [...connected][0] : [...connected].flat();
            group.push(structuredClone(task));
            if (connected.size > 1) for (const [key, previous] of groups) if (connected.has(previous)) groups.set(key, group);
            for (const key of keys) groups.set(key, group);
        }
        for (const setting of filterTaskBackupSettings(snapshot.data.settings)) {
            const previous = settings.get(setting.id);
            const time = snapshot.timestamp ?? 0;
            // Nonsecret preferences may choose a stable tie-breaker without
            // blocking unrelated task recovery on simultaneous UI changes.
            if (!previous || time > previous.timestamp || (time === previous.timestamp
                && canonicalBackupJson(setting) > canonicalBackupJson(previous.setting))) {
                settings.set(setting.id, { timestamp: time, setting });
            }
        }
    }
    const tasks: Task[] = [];
    for (const group of new Set(groups.values())) {
        const occurrences = new Set(group.map(task => task.suggestionOccurrenceKey).filter(Boolean));
        const subjects = new Set(group.map(task => task.suggestionSubjectId).filter(Boolean));
        if (occurrences.size > 1 || subjects.size > 1) throw new Error('Konflikt identity návrhu v zálohách úkolů.');
        const occurrence = [...occurrences][0];
        const subject = [...subjects][0];
        const normalized = group.map(task => ({ ...task,
            ...(occurrence ? { suggestionOccurrenceKey: occurrence } : {}),
            ...(subject ? { suggestionSubjectId: subject } : {}),
        }));
        const newest = normalized.reduce((latest, task) => Math.max(latest, version(task)), 0);
        const winners = normalized.filter(task => version(task) === newest);
        if (new Set(winners.map(content)).size > 1) throw new Error('Konflikt stejně nových verzí úkolu v zálohách.');
        // Retain each portable alias so later edits without occurrence metadata
        // remain attached to the same occurrence on either original device.
        const publicIds = [...new Set(group.map(task => task.publicId).filter(Boolean))].sort();
        const winner = winners.map(task => ({ task, key: canonicalBackupJson(task) }))
            .sort((a, b) => a.key.localeCompare(b.key))[0].task;
        if (publicIds.length) for (const publicId of publicIds) tasks.push({ ...winner, publicId });
        else tasks.push(winner);
    }
    return { version: '2.0', timestamp, data: {
        tasks: tasks.map(task => ({ task, key: canonicalBackupJson(task) }))
            .sort((a, b) => a.key.localeCompare(b.key)).map(entry => entry.task),
        settings: [...settings.values()].map(entry => entry.setting).sort((a, b) => a.id.localeCompare(b.id)),
    } };
}
