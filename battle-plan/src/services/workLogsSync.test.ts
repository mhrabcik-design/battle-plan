/// <reference types="node" />
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { BattlePlanDB } from '../db.ts';
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

test('Drive merge does not guess among multiple legacy normalized project matches', async () => {
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
    assert.equal(result.projectsUpdated, 0);
    assert.equal(await db.projects.count(), 2);
    assert.equal((await db.projects.get(firstId))?.color, 'slate');
    assert.equal((await db.projects.get(firstId))?.updatedAt, 20);
    assert.equal((await db.projects.get(secondId))?.color, 'emerald');
    assert.equal((await db.projects.get(secondId))?.updatedAt, 21);
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
    assert.equal(project?.name, ' plaza ');
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
