/// <reference types="node" />
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { BattlePlanDB, Project, WorkLogDeletionTombstone } from '../db.ts';
import type {
    mergeCloudToLocal as MergeCloudToLocal,
    mergeLocalToCloud as MergeLocalToCloud,
} from './workLogsSync.ts';

const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
    clear: () => { storage.clear(); },
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
};

const { DriveRequestError } = await import('./driveJsonStore.ts');
const { buildWorkLogsFileMetadata } = await import('./workLogsDriveMetadata.ts');
// workLogsSync follows the app's extensionless bundler imports, so load this
// integration seam through Vite rather than Node's stricter ESM resolver.
const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    appType: 'custom',
});
const { db } = await vite.ssrLoadModule('/src/db.ts') as { db: BattlePlanDB };
const { mergeCloudToLocal, mergeLocalToCloud, WorkLogsSync, workLogsSync } = await vite.ssrLoadModule('/src/services/workLogsSync.ts') as {
    mergeCloudToLocal: typeof MergeCloudToLocal;
    mergeLocalToCloud: typeof MergeLocalToCloud;
    WorkLogsSync: new (store: unknown) => {
        init: () => Promise<void>;
        loadAllDetailed: () => Promise<unknown>;
        saveAll: (payload: unknown) => Promise<number | null>;
    };
    workLogsSync: unknown;
};
after(async () => vite.close());

async function resetDb(): Promise<void> {
    await db.workLogs.clear();
    await db.projects.clear();
    await db.workLogDeletionTombstones.clear();
}

function withoutProjectPublicId(project: Project | undefined): Omit<Project, 'publicId'> | undefined {
    if (!project) return undefined;
    assert.match(project.publicId ?? '', /^project_[0-9a-f-]{36}$/);
    const legacyProject = { ...project };
    delete legacyProject.publicId;
    return legacyProject;
}

test('buildWorkLogsFileMetadata puts a new file into the BattlePlan Drive folder', () => {
    assert.deepEqual(
        buildWorkLogsFileMetadata('folder-123', null),
        {
            name: 'work_logs_data.json',
            mimeType: 'application/json',
            parents: ['folder-123'],
        },
    );
});

test('buildWorkLogsFileMetadata does not move existing Drive files on update', () => {
    assert.deepEqual(
        buildWorkLogsFileMetadata('folder-123', 'file-456'),
        {
            name: 'work_logs_data.json',
            mimeType: 'application/json',
        },
    );
});

test('U3: Drive merge applies newer archive and restore states without rewriting WorkLog history', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: true, createdAt: 10, updatedAt: 20,
    });
    const workLogId = await db.workLogs.add({
        date: '2026-08-01', projectId, projectName: 'Plaza', people: 'Martin', hours: 8,
        source: 'manual', createdAt: 30, updatedAt: 30,
    });
    const history = await db.workLogs.get(workLogId);

    const archived = await mergeCloudToLocal([], [{
        id: 999,
        name: 'PLAZA',
        color: 'rose',
        isActive: false,
        createdAt: 1,
        updatedAt: 40,
    }]);

    assert.equal(archived.projectsAdded, 0);
    assert.equal(archived.projectsUpdated, 1);
    assert.equal((await db.projects.get(projectId))?.isActive, false);
    assert.equal((await db.projects.get(projectId))?.color, 'rose');
    assert.deepEqual(await db.workLogs.get(workLogId), history);

    const restored = await mergeCloudToLocal([], [{
        id: 999,
        name: 'Plaza',
        color: 'emerald',
        isActive: true,
        createdAt: 1,
        updatedAt: 50,
    }]);

    assert.equal(restored.projectsAdded, 0);
    assert.equal(restored.projectsUpdated, 1);
    assert.equal((await db.projects.get(projectId))?.isActive, true);
    assert.equal((await db.projects.get(projectId))?.color, 'emerald');
    assert.equal(await db.projects.count(), 1);
    assert.deepEqual(await db.workLogs.get(workLogId), history);
});

test('Drive merge matches trim-equivalent project names through catalog normalization', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: '  Plaza  ', color: 'slate', isActive: true, createdAt: 10, updatedAt: 20,
    });

    const result = await mergeCloudToLocal([], [{
        id: 999,
        name: 'PLAZA',
        color: 'rose',
        isActive: false,
        createdAt: 1,
        updatedAt: 40,
    }]);

    assert.equal(result.projectsAdded, 0);
    assert.equal(result.projectsUpdated, 1);
    assert.equal(await db.projects.count(), 1);
    assert.deepEqual(withoutProjectPublicId(await db.projects.get(projectId)), {
        id: projectId,
        name: 'PLAZA',
        color: 'rose',
        isActive: false,
        createdAt: 10,
        updatedAt: 40,
    });
});

test('Drive merge reconciles legacy normalized project matches before applying cloud state', async () => {
    await resetDb();
    const firstId = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: true, createdAt: 10, updatedAt: 20,
    });
    const secondId = await db.projects.add({
        name: ' plaza ', color: 'emerald', isActive: false, createdAt: 11, updatedAt: 21,
    });

    const result = await mergeCloudToLocal([], [{
        id: 999,
        name: 'PLAZA',
        color: 'rose',
        isActive: true,
        createdAt: 1,
        updatedAt: 40,
    }]);

    assert.equal(result.projectsAdded, 0);
    assert.equal(result.projectsUpdated, 1);
    assert.equal(await db.projects.count(), 1);
    assert.deepEqual(withoutProjectPublicId(await db.projects.get(firstId)), {
        id: firstId,
        name: 'PLAZA',
        color: 'rose',
        isActive: true,
        createdAt: 10,
        updatedAt: 40,
    });
    assert.equal(await db.projects.get(secondId), undefined);
});

test('Drive merge turns repeated orphaned WorkLog names into one reusable project', async () => {
    await resetDb();

    const result = await mergeCloudToLocal([
        {
            id: 100,
            syncId: 'kb-1',
            date: '2026-08-01',
            projectId: 998,
            projectName: 'Komerční banka',
            people: 'Martin',
            hours: 2,
            source: 'manual',
            createdAt: 10,
            updatedAt: 10,
        },
        {
            id: 101,
            syncId: 'kb-2',
            date: '2026-08-02',
            projectId: 999,
            projectName: '  KOMERČNÍ BANKA ',
            people: 'Martin',
            hours: 3,
            source: 'manual',
            createdAt: 20,
            updatedAt: 20,
        },
    ], []);

    assert.equal(result.projectsAdded, 1);
    const [project] = await db.projects.toArray();
    assert.equal(project?.name, 'Komerční banka');
    assert.deepEqual(
        (await db.workLogs.orderBy('date').toArray()).map((workLog) => ({
            projectId: workLog.projectId,
            projectName: workLog.projectName,
        })),
        [
            { projectId: project?.id, projectName: 'Komerční banka' },
            { projectId: project?.id, projectName: '  KOMERČNÍ BANKA ' },
        ],
    );
});

test('Drive merge preserves separate rows when their sync identities differ', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: 'Komerční Banka', color: 'amber', isActive: true, createdAt: 10, updatedAt: 10,
    });
    const sharedFields = {
        date: '2026-06-22',
        projectId,
        projectName: 'Komerční Banka',
        people: 'Martin, Sergej, Sergejův bratr',
        hours: 30,
        source: 'voice' as const,
        createdAt: 20,
        updatedAt: 20,
    };
    await db.workLogs.add({ ...sharedFields, syncId: 'device-a' });

    const result = await mergeCloudToLocal([
        { ...sharedFields, id: 101, syncId: 'device-b' },
        { ...sharedFields, id: 102, syncId: 'device-c' },
        { ...sharedFields, id: 103, syncId: 'device-d' },
    ], []);

    const workLogs = await db.workLogs.toArray();
    assert.equal(workLogs.length, 4);
    assert.equal(workLogs.reduce((sum, workLog) => sum + workLog.hours, 0), 120);
    assert.equal(result.workLogsAdded, 3);
});

test('Drive keeps distinct sync identities after cloud alias reconciliation', async () => {
    await resetDb();
    const survivorId = await db.projects.add({
        name: 'Komerční Banka', color: 'amber', isActive: true, createdAt: 10, updatedAt: 10,
    });
    const sourceId = await db.projects.add({
        name: 'Komerční banka Plaza', color: 'slate', isActive: true, createdAt: 11, updatedAt: 11,
    });
    const sharedFields = {
        date: '2026-06-22', projectId: sourceId, projectName: 'Komerční banka Plaza',
        people: 'Martin, Sergej, Sergejův bratr', hours: 30, source: 'voice' as const,
        createdAt: 20, updatedAt: 20,
    };
    await db.workLogs.add({ ...sharedFields, syncId: 'device-a' });

    const result = await mergeCloudToLocal([
        { ...sharedFields, id: 101, projectId: 999, syncId: 'device-b' },
    ], [{
        id: 900,
        name: 'Komerční Banka',
        aliases: ['Komerční banka Plaza'],
        color: 'amber',
        isActive: true,
        createdAt: 10,
        updatedAt: 30,
    }]);

    const workLogs = await db.workLogs.toArray();
    assert.equal(workLogs.length, 2);
    assert.deepEqual([...new Set(workLogs.map((workLog) => workLog.projectId))], [survivorId]);
    assert.equal(result.workLogsAdded, 1);
});

test('Drive merge does not attach an imported orphan to an unrelated local project id', async () => {
    await resetDb();
    const unrelatedId = await db.projects.add({
        name: 'Jiný projekt', color: 'rose', isActive: true, createdAt: 1, updatedAt: 1,
    });

    await mergeCloudToLocal([{
        id: 100,
        syncId: 'imported-orphan',
        date: '2026-08-04',
        projectId: unrelatedId,
        projectName: 'Komerční banka',
        people: 'Martin',
        hours: 2,
        source: 'manual',
        createdAt: 10,
        updatedAt: 10,
    }], []);

    const projects = await db.projects.toArray();
    const importedProject = projects.find((project) => project.name === 'Komerční banka');
    assert.ok(importedProject?.id);
    assert.notEqual(importedProject.id, unrelatedId);
    assert.equal((await db.workLogs.toArray())[0]?.projectId, importedProject.id);
});

test('Drive merge keeps normalized project buckets current within one cloud payload', async () => {
    await resetDb();

    const result = await mergeCloudToLocal([], [
        {
            id: 998,
            name: 'Plaza',
            color: 'slate',
            isActive: true,
            createdAt: 10,
            updatedAt: 20,
        },
        {
            id: 999,
            name: ' plaza ',
            color: 'rose',
            isActive: false,
            createdAt: 11,
            updatedAt: 40,
        },
    ]);

    assert.equal(result.projectsAdded, 1);
    assert.equal(result.projectsUpdated, 1);
    assert.equal(await db.projects.count(), 1);
    const [project] = await db.projects.toArray();
    assert.equal(project?.name, 'plaza');
    assert.equal(project?.color, 'rose');
    assert.equal(project?.isActive, false);
    assert.equal(project?.createdAt, 10);
    assert.equal(project?.updatedAt, 40);
});

test('overlapping Drive merges cannot create normalized project duplicates', async () => {
    await resetDb();

    const results = await Promise.all([
        mergeCloudToLocal([], [{
            id: 998,
            name: 'Plaza',
            color: 'slate',
            isActive: true,
            createdAt: 10,
            updatedAt: 20,
        }]),
        mergeCloudToLocal([], [{
            id: 999,
            name: ' plaza ',
            color: 'rose',
            isActive: false,
            createdAt: 11,
            updatedAt: 40,
        }]),
    ]);

    assert.equal(results.reduce((sum, result) => sum + result.projectsAdded, 0), 1);
    assert.equal(await db.projects.count(), 1);
    const [project] = await db.projects.toArray();
    assert.equal(project?.color, 'rose');
    assert.equal(project?.updatedAt, 40);
});

test('Drive merge cannot resurrect a stale source owned as a survivor alias', async () => {
    await resetDb();
    const survivorId = await db.projects.add({
        name: 'Komerční Banka',
        aliases: ['Komerční banka Plaza'],
        color: 'indigo',
        isActive: true,
        source: 'user',
        createdAt: 10,
        updatedAt: 100,
    });

    await mergeCloudToLocal([{
        id: 500,
        syncId: 'stale-plaza-log',
        date: '2026-08-08',
        projectId: 999,
        projectName: 'Komerční banka Plaza',
        people: 'Martin',
        hours: 3,
        source: 'manual',
        createdAt: 20,
        updatedAt: 20,
    }], [{
        id: 999,
        name: 'Komerční banka Plaza',
        aliases: ['KB Plaza', null, 42] as unknown as string[],
        color: 'rose',
        isActive: false,
        source: 'agent',
        createdAt: 5,
        updatedAt: 999,
    }]);

    assert.deepEqual((await db.projects.toArray()).map(withoutProjectPublicId), [{
        id: survivorId,
        name: 'Komerční Banka',
        aliases: ['KB Plaza', 'Komerční banka Plaza'],
        color: 'indigo',
        isActive: true,
        source: 'user',
        createdAt: 10,
        updatedAt: 1000,
    }]);
    const [imported] = await db.workLogs.toArray();
    assert.equal(imported?.projectId, survivorId);
    assert.equal(imported?.projectName, 'Komerční banka Plaza');
});

test('Drive alias convergence is independent of cloud project order and idempotent', async () => {
    async function mergeOrder(projects: Project[]): Promise<Project[]> {
        await resetDb();
        await db.projects.add({
            name: 'A', aliases: ['B'], color: 'indigo', isActive: true, createdAt: 1, updatedAt: 10,
        });
        await mergeCloudToLocal([], projects);
        await mergeCloudToLocal([], [...projects].reverse());
        return (await db.projects.toArray()).map((project) => ({
            ...withoutProjectPublicId(project)!,
            id: 0,
        }));
    }

    const cloudProjects: Project[] = [
        { id: 900, name: 'B', aliases: ['C'], color: 'rose', isActive: true, createdAt: 2, updatedAt: 20 },
        { id: 901, name: 'C', aliases: ['D'], color: 'slate', isActive: false, createdAt: 3, updatedAt: 30 },
    ];
    const forward = await mergeOrder(cloudProjects);
    const reverse = await mergeOrder([...cloudProjects].reverse());

    assert.deepEqual(forward, reverse);
    assert.deepEqual(forward, [{
        id: 0,
        name: 'A', aliases: ['B', 'C', 'D'], color: 'indigo', isActive: true,
        createdAt: 1, updatedAt: 31,
    }]);
});

test('alias-only Drive convergence advances the project hash once', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: 'A', aliases: ['B'], color: 'indigo', isActive: true,
        createdAt: 1, updatedAt: 100,
    });

    await mergeCloudToLocal([], [{
        id: 900, name: 'B', aliases: ['C'], color: 'rose', isActive: false,
        createdAt: 2, updatedAt: 20,
    }]);
    const first = await db.projects.get(projectId);
    assert.deepEqual(first?.aliases, ['B', 'C']);
    assert.equal(first?.updatedAt, 101);

    await mergeCloudToLocal([], [{
        id: 900, name: 'B', aliases: ['C'], color: 'rose', isActive: false,
        createdAt: 2, updatedAt: 20,
    }]);
    assert.deepEqual(await db.projects.get(projectId), first);
});

test('mergeLocalToCloud aborts without writing when the Drive pull fails', async () => {
    await resetDb();
    await db.projects.add({
        name: 'Local only', color: 'indigo', isActive: true, createdAt: 1, updatedAt: 1,
    });
    const sync = workLogsSync as {
        isInitialized: boolean;
        loadAllDetailed: () => Promise<unknown>;
        saveAll: (payload: unknown) => Promise<number | null>;
    };
    const originalInitialized = sync.isInitialized;
    const originalLoad = sync.loadAllDetailed;
    const originalSave = sync.saveAll;
    let saveCalls = 0;
    try {
        sync.isInitialized = true;
        sync.loadAllDetailed = async () => ({
            kind: 'error', message: 'temporary Drive read failure',
            data: { workLogs: [], projects: [], timestamp: 0 },
        });
        sync.saveAll = async () => {
            saveCalls += 1;
            return 123;
        };

        assert.equal(await mergeLocalToCloud(), false);
        assert.equal(saveCalls, 0);
    } finally {
        sync.isInitialized = originalInitialized;
        sync.loadAllDetailed = originalLoad;
        sync.saveAll = originalSave;
    }
});

test('mergeLocalToCloud retries the full pull after a conditional save conflict', async () => {
    await resetDb();
    const sync = workLogsSync as {
        isInitialized: boolean;
        loadAllDetailed: () => Promise<unknown>;
        saveAll: (payload: unknown) => Promise<number | null>;
    };
    const originalInitialized = sync.isInitialized;
    const originalLoad = sync.loadAllDetailed;
    const originalSave = sync.saveAll;
    let loadCalls = 0;
    let saveCalls = 0;
    try {
        sync.isInitialized = true;
        sync.loadAllDetailed = async () => {
            loadCalls += 1;
            return {
                kind: 'missing-file',
                data: { workLogs: [], projects: [], workLogDeletionTombstones: [], timestamp: 0 },
            };
        };
        sync.saveAll = async () => {
            saveCalls += 1;
            if (saveCalls === 1) throw new DriveRequestError(412, 'stale Drive revision');
            return 21;
        };

        assert.equal(await mergeLocalToCloud(), true);
        assert.equal(loadCalls, 2);
        assert.equal(saveCalls, 2);
    } finally {
        sync.isInitialized = originalInitialized;
        sync.loadAllDetailed = originalLoad;
        sync.saveAll = originalSave;
    }
});

test('durable tombstones stop a stale second device from resurrecting confirmed copies', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: 'Komerční Banka', color: 'amber', isActive: true, createdAt: 1, updatedAt: 1,
    });
    const sharedFields = {
        date: '2026-06-22', projectId, projectName: 'Komerční Banka', people: 'Martin',
        hours: 8, source: 'manual' as const, createdAt: 10, updatedAt: 10,
    };
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'keep-me' },
        { ...sharedFields, syncId: 'remove-me' },
    ]);
    const tombstone: WorkLogDeletionTombstone = {
        syncId: 'remove-me',
        survivorSyncId: 'keep-me',
        fingerprint: 'confirmed-copy',
        reason: 'confirmed-duplicate',
        deletedAt: 20,
    };
    await db.workLogDeletionTombstones.put(tombstone);
    await db.workLogs.where('syncId').equals('remove-me').delete();

    const sync = workLogsSync as {
        isInitialized: boolean;
        loadAllDetailed: () => Promise<unknown>;
        saveAll: (payload: {
            workLogs: Array<{ syncId?: string }>;
            workLogDeletionTombstones: WorkLogDeletionTombstone[];
        }) => Promise<number | null>;
    };
    const originalInitialized = sync.isInitialized;
    const originalLoad = sync.loadAllDetailed;
    const originalSave = sync.saveAll;
    let savedSyncIds: Array<string | undefined> = [];
    try {
        sync.isInitialized = true;
        sync.loadAllDetailed = async () => ({
            kind: 'loaded',
            data: {
                timestamp: 20,
                projects: [],
                workLogs: [
                    { ...sharedFields, id: 101, syncId: 'remove-me' },
                    { ...sharedFields, id: 102, syncId: 'unrelated', date: '2026-06-23' },
                ],
                workLogDeletionTombstones: [],
            },
        });
        sync.saveAll = async (payload) => {
            savedSyncIds = payload.workLogs.map((workLog) => workLog.syncId).sort();
            assert.deepEqual(payload.workLogDeletionTombstones, [tombstone]);
            return 21;
        };

        assert.equal(await mergeLocalToCloud(), true);
        assert.deepEqual(savedSyncIds, ['keep-me', 'unrelated']);
        assert.deepEqual(
            (await db.workLogs.toArray()).map((workLog) => workLog.syncId).sort(),
            ['keep-me', 'unrelated'],
        );
    } finally {
        sync.isInitialized = originalInitialized;
        sync.loadAllDetailed = originalLoad;
        sync.saveAll = originalSave;
    }
});

test('duplicate WorkLogs Drive files merge and remain available for later stale-client writes', async () => {
    const tombstone: WorkLogDeletionTombstone = {
        syncId: 'removed-copy', survivorSyncId: 'survivor', fingerprint: 'copy',
        reason: 'confirmed-duplicate', deletedAt: 20,
    };
    const project: Project = {
        id: 1, name: 'Plaza', color: 'amber', isActive: true, createdAt: 1, updatedAt: 1,
    };
    const workLog = {
        id: 1, syncId: 'survivor', date: '2026-08-01', projectId: 1, projectName: 'Plaza',
        people: 'Martin', hours: 8, source: 'manual' as const, createdAt: 10, updatedAt: 10,
    };
    const files = [
        {
            fileId: 'file-a', etag: '"etag-a"',
            data: { version: 2, last_updated: 20, workLogs: [workLog], projects: [project], workLogDeletionTombstones: [] },
        },
        {
            fileId: 'file-b', etag: '"etag-b"',
            data: { version: 1, last_updated: 21, workLogs: [], projects: [] },
        },
    ];
    const tombstoneFiles = [{
        fileId: 'tombstone-a', etag: '"tombstone-etag-a"',
        data: { version: 1, last_updated: 22, tombstones: [tombstone] },
    }];
    const writes: Array<{ name: string; fileId?: string | null; options?: unknown; payload: unknown }> = [];
    const store = {
        lastStatus: { code: 'ready' as const, message: 'ready' },
        init: async () => true,
        readJsonFilesWithStatus: async (name: string) => ({
            kind: 'loaded' as const,
            files: structuredClone(name === 'work_logs_data.json' ? files : tombstoneFiles),
        }),
        writeJsonFile: async (name: string, payload: unknown, fileId?: string | null, options?: unknown) => {
            writes.push({ name, payload: structuredClone(payload), fileId, options });
            return {
                fileId: fileId ?? 'file-a',
                etag: name === 'work_logs_data.json' ? '"etag-a-2"' : '"tombstone-etag-a-2"',
            };
        },
    };
    const sync = new WorkLogsSync(store);
    await sync.init();
    const loaded = await sync.loadAllDetailed() as { kind: string; data: { workLogs: unknown[]; workLogDeletionTombstones: unknown[] } };

    assert.equal(loaded.kind, 'loaded');
    assert.equal(loaded.data.workLogs.length, 1);
    assert.deepEqual(loaded.data.workLogDeletionTombstones, [tombstone]);
    assert.ok(await sync.saveAll({ workLogs: [workLog], projects: [project], workLogDeletionTombstones: [tombstone] }));
    assert.deepEqual(writes.map(({ name, fileId, options }) => ({ name, fileId, options })), [
        { name: 'work_log_deletion_tombstones.json', fileId: 'tombstone-a', options: { ifMatch: '"tombstone-etag-a"' } },
        { name: 'work_logs_data.json', fileId: 'file-a', options: { ifMatch: '"etag-a"' } },
    ]);
    assert.ok(await sync.saveAll({ workLogs: [workLog], projects: [project], workLogDeletionTombstones: [tombstone] }));
    assert.deepEqual(writes.slice(2).map(({ name, fileId, options }) => ({ name, fileId, options })), [
        { name: 'work_log_deletion_tombstones.json', fileId: 'tombstone-a', options: { ifMatch: '"tombstone-etag-a-2"' } },
        { name: 'work_logs_data.json', fileId: 'file-a', options: { ifMatch: '"etag-a-2"' } },
    ]);
});

test('WorkLogs existing files without ETags fail closed before any write', async () => {
    const cases = [
        { missingEtagFor: 'work_logs_data.json', tombstones: [] as WorkLogDeletionTombstone[] },
        {
            missingEtagFor: 'work_log_deletion_tombstones.json',
            tombstones: [{
                syncId: 'removed-copy', survivorSyncId: 'survivor', fingerprint: 'copy',
                reason: 'confirmed-duplicate' as const, deletedAt: 20,
            }],
        },
    ];
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
        for (const { missingEtagFor, tombstones } of cases) {
            let writeCount = 0;
            const store = {
                lastStatus: { code: 'ready' as const, message: 'ready' },
                init: async () => true,
                readJsonFilesWithStatus: async (name: string) => {
                    if (missingEtagFor === 'work_logs_data.json' && name === 'work_log_deletion_tombstones.json') {
                        return { kind: 'missing-file' as const };
                    }
                    return {
                        kind: 'loaded' as const,
                        files: [{
                            fileId: `${name}-id`,
                            ...(name === missingEtagFor ? {} : { etag: `"${name}-etag"` }),
                            data: name === 'work_logs_data.json'
                                ? { version: 2, last_updated: 1, workLogs: [], projects: [], workLogDeletionTombstones: [] }
                                : { version: 1, last_updated: 1, tombstones },
                        }],
                    };
                },
                writeJsonFile: async () => {
                    writeCount++;
                    return { fileId: 'unexpected-write' };
                },
            };
            const sync = new WorkLogsSync(store);
            await sync.init();
            await sync.loadAllDetailed();

            assert.equal(
                await sync.saveAll({ workLogs: [], projects: [], workLogDeletionTombstones: tombstones }),
                null,
                missingEtagFor,
            );
            assert.equal(writeCount, 0, missingEtagFor);
        }
    } finally {
        console.error = originalConsoleError;
    }
});

test('a WorkLogs 412 after journal creation retains the journal revision for retry', async () => {
    const tombstone: WorkLogDeletionTombstone = {
        syncId: 'removed-copy', survivorSyncId: 'survivor', fingerprint: 'copy',
        reason: 'confirmed-duplicate', deletedAt: 20,
    };
    const writes: Array<{ name: string; fileId?: string | null; options?: unknown }> = [];
    let workLogsWrites = 0;
    const store = {
        lastStatus: { code: 'ready' as const, message: 'ready' },
        init: async () => true,
        readJsonFilesWithStatus: async () => ({ kind: 'missing-file' as const }),
        writeJsonFile: async (name: string, _payload: unknown, fileId?: string | null, options?: unknown) => {
            writes.push({ name, fileId, options });
            if (name === 'work_log_deletion_tombstones.json') {
                return { fileId: fileId ?? 'journal-1', etag: fileId ? '"journal-etag-2"' : '"journal-etag-1"' };
            }
            workLogsWrites += 1;
            if (workLogsWrites === 1) throw new DriveRequestError(412, 'stale WorkLogs revision');
            return { fileId: 'worklogs-1', etag: '"worklogs-etag-1"' };
        },
    };
    const sync = new WorkLogsSync(store);
    await sync.init();
    const payload = { workLogs: [], projects: [], workLogDeletionTombstones: [tombstone] };

    await assert.rejects(sync.saveAll(payload), (error: unknown) => (
        error instanceof Error && 'status' in error && error.status === 412
    ));
    assert.ok(await sync.saveAll(payload));

    assert.deepEqual(writes.map(({ name, fileId, options }) => ({ name, fileId, options })), [
        { name: 'work_log_deletion_tombstones.json', fileId: null, options: { createOnly: true } },
        { name: 'work_logs_data.json', fileId: null, options: { createOnly: true } },
        { name: 'work_log_deletion_tombstones.json', fileId: 'journal-1', options: { ifMatch: '"journal-etag-1"' } },
        { name: 'work_logs_data.json', fileId: null, options: { createOnly: true } },
    ]);
});

test('remote tombstones delete stale local copies and converge monotonically', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: 'Komerční Banka', color: 'amber', isActive: true, createdAt: 1, updatedAt: 1,
    });
    const sharedFields = {
        date: '2026-06-22', projectId, projectName: 'Komerční Banka', people: 'Martin',
        hours: 8, source: 'manual' as const, createdAt: 10, updatedAt: 10,
    };
    await db.workLogs.bulkAdd([
        { ...sharedFields, syncId: 'keep-me' },
        { ...sharedFields, syncId: 'remove-me' },
    ]);
    const remoteTombstone: WorkLogDeletionTombstone = {
        syncId: 'remove-me', survivorSyncId: 'keep-me', fingerprint: 'confirmed-copy',
        reason: 'confirmed-duplicate', deletedAt: 20,
    };

    await mergeCloudToLocal(
        [{ ...sharedFields, id: 101, syncId: 'remove-me' }],
        [],
        [remoteTombstone],
    );

    assert.deepEqual((await db.workLogs.toArray()).map((row) => row.syncId), ['keep-me']);
    assert.deepEqual(await db.workLogDeletionTombstones.toArray(), [remoteTombstone]);
});

test('conflicting tombstone identity fails closed without deleting local work', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: 'Komerční Banka', color: 'amber', isActive: true, createdAt: 1, updatedAt: 1,
    });
    const workLog = {
        date: '2026-06-22', projectId, projectName: 'Komerční Banka', people: 'Martin',
        hours: 8, source: 'manual' as const, syncId: 'removed-copy', createdAt: 10, updatedAt: 10,
    };
    await db.workLogs.add(workLog);
    const localTombstone: WorkLogDeletionTombstone = {
        syncId: 'removed-copy', survivorSyncId: 'survivor-a', fingerprint: 'copy-a',
        reason: 'confirmed-duplicate', deletedAt: 20,
    };
    await db.workLogDeletionTombstones.put(localTombstone);

    await assert.rejects(
        mergeCloudToLocal([], [], [{
            ...localTombstone,
            survivorSyncId: 'survivor-b',
        }]),
        /conflicting WorkLog tombstone/,
    );

    assert.equal((await db.workLogs.toArray())[0]?.syncId, 'removed-copy');
    assert.deepEqual(await db.workLogDeletionTombstones.toArray(), [localTombstone]);
});

test('WorkLogs Drive sync serializes overlapping backup triggers', async () => {
    await resetDb();
    const sync = workLogsSync as {
        isInitialized: boolean;
        loadAllDetailed: () => Promise<unknown>;
        saveAll: (payload: unknown) => Promise<number | null>;
    };
    const originalInitialized = sync.isInitialized;
    const originalLoad = sync.loadAllDetailed;
    const originalSave = sync.saveAll;
    let releaseFirstRead: (() => void) | undefined;
    let activeReads = 0;
    let maxActiveReads = 0;
    try {
        sync.isInitialized = true;
        sync.loadAllDetailed = async () => {
            activeReads += 1;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
            if (!releaseFirstRead) {
                await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
            }
            activeReads -= 1;
            return {
                kind: 'missing-file',
                data: { workLogs: [], projects: [], workLogDeletionTombstones: [], timestamp: 0 },
            };
        };
        sync.saveAll = async () => 21;

        const first = mergeLocalToCloud();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const second = mergeLocalToCloud();
        releaseFirstRead?.();
        assert.deepEqual(await Promise.all([first, second]), [true, true]);
        assert.equal(maxActiveReads, 1);
    } finally {
        sync.isInitialized = originalInitialized;
        sync.loadAllDetailed = originalLoad;
        sync.saveAll = originalSave;
    }
});

test('Drive identity conflict rejects atomically before importing projects or WorkLogs', async () => {
    await resetDb();
    await db.projects.add({
        name: 'A', aliases: ['Shared'], color: 'indigo', isActive: true, createdAt: 1, updatedAt: 1,
    });
    const beforeProjects = await db.projects.toArray();

    await assert.rejects(mergeCloudToLocal([{
        id: 99, syncId: 'must-not-import', date: '2026-08-08', projectId: 99,
        projectName: 'B', people: 'Martin', hours: 1, source: 'manual', createdAt: 5, updatedAt: 5,
    }], [{
        id: 99, name: 'B', aliases: ['shared'], color: 'rose', isActive: true,
        createdAt: 2, updatedAt: 2,
    }]));

    assert.deepEqual(await db.projects.toArray(), beforeProjects);
    assert.equal(await db.workLogs.count(), 0);

    await resetDb();
    const cyclePayload: Project[] = [
        { id: 1, name: 'A', aliases: ['B'], color: 'indigo', isActive: true, createdAt: 1, updatedAt: 1 },
        { id: 2, name: 'B', aliases: ['A'], color: 'rose', isActive: true, createdAt: 2, updatedAt: 2 },
    ];
    await assert.rejects(mergeCloudToLocal([], cyclePayload));
    assert.equal(await db.projects.count(), 0);
});
