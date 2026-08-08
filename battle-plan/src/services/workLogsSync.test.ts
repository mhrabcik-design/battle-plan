/// <reference types="node" />
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { BattlePlanDB, Project } from '../db.ts';
import type { mergeCloudToLocal as MergeCloudToLocal } from './workLogsSync.ts';

const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
    clear: () => { storage.clear(); },
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
};

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
const { mergeCloudToLocal } = await vite.ssrLoadModule('/src/services/workLogsSync.ts') as {
    mergeCloudToLocal: typeof MergeCloudToLocal;
};
after(async () => vite.close());

async function resetDb(): Promise<void> {
    await db.workLogs.clear();
    await db.projects.clear();
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
    assert.deepEqual(await db.projects.get(projectId), {
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
    assert.deepEqual(await db.projects.get(firstId), {
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

    assert.deepEqual(await db.projects.toArray(), [{
        id: survivorId,
        name: 'Komerční Banka',
        aliases: ['KB Plaza', 'Komerční banka Plaza'],
        color: 'indigo',
        isActive: true,
        source: 'user',
        createdAt: 10,
        updatedAt: 100,
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
        return (await db.projects.toArray()).map((project) => ({ ...project, id: 0 }));
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
        createdAt: 1, updatedAt: 10,
    }]);
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
