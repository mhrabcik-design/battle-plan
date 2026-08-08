/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db, type Project, type WorkLog } from '../db.ts';
import {
    archiveProject,
    createProject,
    mergeProjects,
    previewProjectMerge,
    restoreProject,
    updateProject,
} from './projectCatalog.ts';

async function resetCatalogDb(): Promise<void> {
    await db.workLogs.clear();
    await db.projects.clear();
}

async function seedProject(overrides: Partial<Project> = {}): Promise<Project> {
    const project: Project = {
        name: 'Plaza',
        color: 'slate',
        isActive: true,
        source: 'user',
        updatedAt: 20,
        createdAt: 10,
        ...overrides,
    };
    const id = await db.projects.add(project);
    return { ...project, id: id as number };
}

test('U1: create trims the name and records a durable user project identity', async () => {
    await resetCatalogDb();

    const result = await createProject({ name: '  KB Plaza  ', color: 'indigo', source: 'user' });

    assert.equal(result.outcome, 'created');
    assert.ok(result.project.id);
    assert.equal(result.project.name, 'KB Plaza');
    assert.equal(result.project.color, 'indigo');
    assert.equal(result.project.source, 'user');
    assert.equal(result.project.createdAt, result.project.updatedAt);
    assert.deepEqual(await db.projects.get(result.project.id!), result.project);
});

test('U1: active case-and-space equivalent create returns duplicate without writing', async () => {
    await resetCatalogDb();
    const original = await seedProject({ name: 'KB Plaza' });

    const result = await createProject({ name: '  kb plaza  ', color: 'rose', source: 'user' });

    assert.equal(result.outcome, 'duplicate');
    assert.equal(result.project.id, original.id);
    assert.deepEqual(await db.projects.toArray(), [original]);
});

test('U1: archived match requires confirmation, then restores the same id and applies supplied color', async () => {
    await resetCatalogDb();
    const original = await seedProject({ name: 'KB Plaza', color: 'slate', isActive: false });

    const unconfirmed = await createProject({ name: ' kb plaza ', color: 'rose', source: 'user' });
    assert.equal(unconfirmed.outcome, 'archived-match');
    assert.equal(unconfirmed.project.id, original.id);
    assert.deepEqual(await db.projects.get(original.id!), original, 'archived match must be read-only');

    const confirmed = await createProject({
        name: ' kb plaza ',
        color: 'rose',
        source: 'user',
        confirmRestore: true,
    });
    assert.equal(confirmed.outcome, 'restored');
    assert.equal(confirmed.project.id, original.id);
    assert.equal(confirmed.project.name, original.name, 'restoring a case variant is not a rename');
    assert.equal(confirmed.project.color, 'rose');
    assert.equal(confirmed.project.isActive, true);
    assert.equal(confirmed.project.createdAt, original.createdAt);
});

test('U1: explicit restore without color preserves color, identity, attribution, and worklog history', async () => {
    await resetCatalogDb();
    const original = await seedProject({ color: 'amber', isActive: false, source: 'agent', agent_write_id: 'seed-agent' });
    const workLog: WorkLog = {
        date: '2026-08-01',
        projectId: original.id!,
        projectName: original.name,
        people: 'A',
        hours: 8,
        source: 'manual',
        updatedAt: 30,
        createdAt: 30,
    };
    const workLogId = await db.workLogs.add(workLog);

    const result = await restoreProject({ id: original.id! });

    assert.equal(result.outcome, 'restored');
    assert.equal(result.project.id, original.id);
    assert.equal(result.project.color, 'amber');
    assert.equal(result.project.source, 'agent');
    assert.equal(result.project.agent_write_id, 'seed-agent');
    assert.equal(result.project.createdAt, original.createdAt);
    assert.deepEqual(await db.workLogs.get(workLogId), { ...workLog, id: workLogId });
});

test('U1: update color and archive preserve id, name, createdAt, attribution, and worklogs', async () => {
    await resetCatalogDb();
    const original = await seedProject({ source: 'agent', agent_write_id: 'creator' });
    const workLogId = await db.workLogs.add({
        date: '2026-08-01', projectId: original.id!, projectName: original.name,
        people: 'A', hours: 4, source: 'agent', agent_write_id: 'wl-1', updatedAt: 40, createdAt: 40,
    });
    const historyBefore = await db.workLogs.get(workLogId);

    const updated = await updateProject({ id: original.id!, color: 'emerald' });
    assert.equal(updated.outcome, 'updated');
    assert.equal(updated.project.id, original.id);
    assert.equal(updated.project.name, original.name);
    assert.equal(updated.project.createdAt, original.createdAt);
    assert.equal(updated.project.source, original.source);
    assert.equal(updated.project.agent_write_id, original.agent_write_id);

    const archived = await archiveProject({ id: original.id! });
    assert.equal(archived.outcome, 'archived');
    assert.equal(archived.project.id, original.id);
    assert.equal(archived.project.isActive, false);
    assert.equal(archived.project.createdAt, original.createdAt);
    assert.deepEqual(await db.workLogs.get(workLogId), historyBefore);
});

test('U1: rename trims a unique name and rejects a normalized duplicate without a partial update', async () => {
    await resetCatalogDb();
    const first = await seedProject({ name: 'Plaza', color: 'slate' });
    const second = await seedProject({ name: 'Riverside', color: 'amber' });

    const renamed = await updateProject({ id: second.id!, name: '  Riverside Office  ' });
    assert.equal(renamed.outcome, 'updated');
    assert.equal(renamed.project.name, 'Riverside Office');

    const duplicate = await updateProject({ id: second.id!, name: '  pLaZa ', color: 'rose' });
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.project.id, first.id);
    assert.deepEqual(await db.projects.get(second.id!), renamed.project, 'rejected rename must not apply its color either');
});

test('U1: invalid or missing ids return validation without partial writes', async () => {
    await resetCatalogDb();
    const original = await seedProject();

    const invalidUpdate = await updateProject({ id: 0, name: 'Changed' });
    const missingArchive = await archiveProject({ id: 999_999 });
    const missingRestore = await restoreProject({ id: 999_999, color: 'rose' });

    assert.equal(invalidUpdate.outcome, 'validation');
    assert.equal(missingArchive.outcome, 'validation');
    assert.equal(missingRestore.outcome, 'validation');
    assert.deepEqual(await db.projects.toArray(), [original]);
});

test('U1: concurrent normalized-equivalent creates leave exactly one row', async () => {
    await resetCatalogDb();

    const results = await Promise.all([
        createProject({ name: 'Plaza', color: 'slate', source: 'user' }),
        createProject({ name: ' plaza ', color: 'rose', source: 'agent', agentWriteId: 'agent-race' }),
    ]);

    assert.deepEqual(results.map((result) => result.outcome).sort(), ['created', 'duplicate']);
    assert.equal(await db.projects.count(), 1);
});

test('manual merge preserves survivor metadata and WorkLog snapshots while absorbing transitive aliases', async () => {
    await resetCatalogDb();
    const survivor = await seedProject({
        name: 'Komerční Banka', aliases: ['KB'], color: 'amber', source: 'agent',
        agent_write_id: 'survivor-agent', createdAt: 5, updatedAt: 50,
    });
    const source = await seedProject({
        name: 'Komerční banka Plaza', aliases: ['  KB PLAZA  ', 'Komerční Banka'],
        color: 'rose', source: 'user', createdAt: 10, updatedAt: 60,
    });
    const workLogs: WorkLog[] = [
        {
            date: '2026-08-01', projectId: source.id!, projectName: 'Komerční banka Plaza',
            people: 'Martin', hours: 2, description: 'Audit', source: 'manual',
            syncId: 'merge-log-1', updatedAt: 70, createdAt: 70,
        },
        {
            date: '2026-08-02', projectId: source.id!, projectName: 'KB PLAZA',
            people: 'Petr', hours: 3, source: 'agent', agent_write_id: 'wl-agent',
            syncId: 'merge-log-2', updatedAt: 80, createdAt: 80,
        },
    ];
    const workLogIds = await db.workLogs.bulkAdd(workLogs, { allKeys: true });
    const before = await db.workLogs.toArray();

    const previewResult = await previewProjectMerge({ sourceProjectId: source.id!, survivorProjectId: survivor.id! });
    assert.equal(previewResult.outcome, 'ready');
    assert.equal(previewResult.preview.sourceWorkLogCount, 2);
    assert.equal(previewResult.preview.survivorWorkLogCount, 0);

    const result = await mergeProjects({
        sourceProjectId: source.id!, survivorProjectId: survivor.id!, previewToken: previewResult.preview.token,
    });

    assert.equal(result.outcome, 'merged');
    assert.equal(result.workLogsRelinked, 2);
    assert.deepEqual(await db.projects.get(source.id!), undefined);
    const merged = await db.projects.get(survivor.id!);
    assert.ok(merged);
    assert.equal(merged.id, survivor.id);
    assert.equal(merged.name, survivor.name);
    assert.equal(merged.color, survivor.color);
    assert.equal(merged.isActive, survivor.isActive);
    assert.equal(merged.createdAt, survivor.createdAt);
    assert.equal(merged.source, survivor.source);
    assert.equal(merged.agent_write_id, survivor.agent_write_id);
    assert.ok(merged.updatedAt > Date.now() - 5_000);
    assert.ok(merged.updatedAt > Math.max(source.updatedAt, survivor.updatedAt));
    assert.deepEqual(merged.aliases, ['KB', 'KB PLAZA', 'Komerční banka Plaza']);

    const after = await db.workLogs.toArray();
    assert.deepEqual(
        after.map((workLog) => ({ ...workLog, projectId: 0 })),
        before.map((workLog) => ({ ...workLog, projectId: 0 })),
        'projectId is the only WorkLog field that may change',
    );
    assert.deepEqual(after.map((workLog) => workLog.projectId), [survivor.id, survivor.id]);
    assert.deepEqual(after.map((workLog) => workLog.id), workLogIds);
});

test('manual merge accepts an archived zero-log source and includes WorkLogs created after preview', async () => {
    await resetCatalogDb();
    const survivor = await seedProject({ name: 'Komerční Banka', updatedAt: 30 });
    const archivedSource = await seedProject({ name: 'Komerční banka Plaza', isActive: false, updatedAt: 40 });

    const zeroPreview = await previewProjectMerge({
        sourceProjectId: archivedSource.id!, survivorProjectId: survivor.id!,
    });
    assert.equal(zeroPreview.outcome, 'ready');
    assert.equal(zeroPreview.preview.sourceWorkLogCount, 0);
    const lateId = await db.workLogs.add({
        date: '2026-08-03', projectId: archivedSource.id!, projectName: archivedSource.name,
        people: '', hours: 1, source: 'manual', updatedAt: 45, createdAt: 45,
    });

    const result = await mergeProjects({
        sourceProjectId: archivedSource.id!, survivorProjectId: survivor.id!, previewToken: zeroPreview.preview.token,
    });
    assert.equal(result.outcome, 'merged');
    assert.equal(result.workLogsRelinked, 1);
    assert.equal((await db.workLogs.get(lateId))?.projectId, survivor.id);
});

test('manual merge rejects invalid, missing, same, inactive, and stale selections without writes', async () => {
    await resetCatalogDb();
    const survivor = await seedProject({ name: 'Survivor', color: 'indigo' });
    const source = await seedProject({ name: 'Source', color: 'rose' });
    const inactive = await seedProject({ name: 'Inactive', isActive: false });
    const beforeProjects = await db.projects.toArray();

    assert.equal((await previewProjectMerge({ sourceProjectId: 0, survivorProjectId: survivor.id! })).outcome, 'validation');
    assert.equal((await previewProjectMerge({ sourceProjectId: 999_999, survivorProjectId: survivor.id! })).outcome, 'validation');
    assert.equal((await previewProjectMerge({ sourceProjectId: survivor.id!, survivorProjectId: survivor.id! })).outcome, 'validation');
    assert.equal((await previewProjectMerge({ sourceProjectId: source.id!, survivorProjectId: inactive.id! })).outcome, 'validation');

    const preview = await previewProjectMerge({ sourceProjectId: source.id!, survivorProjectId: survivor.id! });
    assert.equal(preview.outcome, 'ready');
    await db.projects.update(source.id!, { color: 'emerald', updatedAt: source.updatedAt + 1 });
    const stale = await mergeProjects({
        sourceProjectId: source.id!, survivorProjectId: survivor.id!, previewToken: preview.preview.token,
    });
    assert.equal(stale.outcome, 'stale');
    assert.equal(await db.projects.count(), beforeProjects.length);
    assert.deepEqual(await db.projects.get(survivor.id!), survivor);
    assert.deepEqual(await db.projects.get(source.id!), { ...source, color: 'emerald', updatedAt: source.updatedAt + 1 });
});

test('manual merge rejects third-project alias ownership conflicts without partial writes', async () => {
    await resetCatalogDb();
    const survivor = await seedProject({ name: 'Survivor' });
    const source = await seedProject({ name: 'Source', aliases: ['Reserved identity'] });
    await seedProject({ name: 'Third', aliases: [' reserved IDENTITY '] });
    const beforeProjects = await db.projects.toArray();

    const result = await previewProjectMerge({ sourceProjectId: source.id!, survivorProjectId: survivor.id! });

    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(await db.projects.toArray(), beforeProjects);
});

test('manual merge transaction rolls back survivor and WorkLog writes when source deletion fails', async () => {
    await resetCatalogDb();
    const survivor = await seedProject({ name: 'Survivor', aliases: ['Existing alias'] });
    const source = await seedProject({ name: 'Source' });
    await db.workLogs.add({
        date: '2026-08-04', projectId: source.id!, projectName: source.name,
        people: 'Martin', hours: 4, source: 'manual', updatedAt: 50, createdAt: 50,
    });
    const preview = await previewProjectMerge({ sourceProjectId: source.id!, survivorProjectId: survivor.id! });
    assert.equal(preview.outcome, 'ready');
    const projectsBefore = await db.projects.toArray();
    const workLogsBefore = await db.workLogs.toArray();
    const rejectSourceDeletion = (primaryKey: number): void => {
        if (primaryKey === source.id) throw new Error('injected source deletion failure');
    };
    db.projects.hook('deleting', rejectSourceDeletion);
    try {
        await assert.rejects(
            mergeProjects({
                sourceProjectId: source.id!, survivorProjectId: survivor.id!, previewToken: preview.preview.token,
            }),
            /injected source deletion failure/,
        );
    } finally {
        db.projects.hook('deleting').unsubscribe(rejectSourceDeletion);
    }

    assert.deepEqual(await db.projects.toArray(), projectsBefore);
    assert.deepEqual(await db.workLogs.toArray(), workLogsBefore);
});

test('catalog aliases reserve absorbed and renamed identities, while malformed legacy aliases are ignored safely', async () => {
    await resetCatalogDb();
    const owner = await seedProject({
        name: 'Current', aliases: [' Old ', '', 'OLD', 42, null] as unknown as string[],
    });

    const duplicate = await createProject({ name: ' old ' });
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.project.id, owner.id);

    const renamed = await updateProject({ id: owner.id!, name: 'New current' });
    assert.equal(renamed.outcome, 'updated');
    assert.deepEqual(renamed.project.aliases, ['Current', 'Old']);

    const reservedOldCanonical = await createProject({ name: 'current' });
    assert.equal(reservedOldCanonical.outcome, 'duplicate');
    assert.equal(reservedOldCanonical.project.id, owner.id);
});
