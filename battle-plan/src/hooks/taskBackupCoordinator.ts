import type { TaskDriveBackupData, TaskDriveBackupLoadResult, TaskDriveBackupPayload } from '../services/taskDriveBackup.ts';

/** Publishing readiness is allowed only after the downloaded snapshot is merged. */
export async function hydrateTaskBackup(
    load: () => Promise<TaskDriveBackupLoadResult>,
    apply: (payload: TaskDriveBackupPayload) => Promise<void>,
    isActive: () => boolean,
) {
    const result = await load();
    if (!isActive()) return { result, ready: false };
    if (result.kind === 'loaded') await apply(result.payload);
    return { result, ready: isActive() && (result.kind === 'loaded' || result.kind === 'missing-file') };
}

export interface TaskBackupSnapshot {
    revision: string;
    data: TaskDriveBackupData;
}

interface TaskBackupCoordinatorOptions {
    save: (data: TaskDriveBackupData) => Promise<number | null>;
    onSaved: (timestamp: number) => void;
    onError: (error: unknown) => void;
    delayMs?: number;
    schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clear?: (timer: ReturnType<typeof setTimeout>) => void;
}

// A torn-down hook may still have an uncancellable Drive request. New hook
// instances wait for it instead of starting a competing snapshot replacement.
let activeWrite: Promise<number | null> | undefined;

export function createTaskBackupCoordinator(options: TaskBackupCoordinatorOptions) {
    const schedule = options.schedule ?? setTimeout;
    const clear = options.clear ?? clearTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: TaskBackupSnapshot | undefined;
    let savedRevision: string | undefined;
    let enabled = false;
    let stopped = false;
    let running = false;

    const clearTimer = () => {
        if (timer !== undefined) clear(timer);
        timer = undefined;
    };

    const schedulePending = () => {
        clearTimer();
        if (stopped || !enabled || running || !pending || pending.revision === savedRevision) return;
        timer = schedule(() => { void flush(); }, options.delayMs ?? 10_000);
    };

    const flush = async (): Promise<void> => {
        clearTimer();
        if (stopped || !enabled || running || !pending || pending.revision === savedRevision) return;
        running = true;
        try {
            while (activeWrite) await activeWrite.catch(() => undefined);
            if (stopped || !enabled || !pending || pending.revision === savedRevision) return;
            const snapshot = pending;
            const write = Promise.resolve().then(() => stopped || !enabled ? null : options.save(snapshot.data));
            activeWrite = write;
            let timestamp: number | null;
            try {
                timestamp = await write;
            } finally {
                if (activeWrite === write) activeWrite = undefined;
            }
            if (timestamp === null) throw new Error('Zálohu se nepodařilo uložit na Disk.');
            savedRevision = snapshot.revision;
            if (!stopped && enabled) options.onSaved(timestamp);
        } catch (error) {
            if (!stopped && enabled) options.onError(error);
        } finally {
            running = false;
            schedulePending();
        }
    };

    return {
        update(snapshot: TaskBackupSnapshot | undefined, canSave: boolean) {
            pending = snapshot;
            enabled = canSave;
            schedulePending();
        },
        flush,
        stop() {
            stopped = true;
            clearTimer();
        },
    };
}
