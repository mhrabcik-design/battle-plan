/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db, type Project, type WorkLog } from '../db.ts';
import {
    archiveProject,
    createProject,
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

test('U1: seeded legacy normalized collisions return conflict and are not merged or remapped', async () => {
    await resetCatalogDb();
    const first = await seedProject({ name: 'Plaza', color: 'slate', isActive: true });
    const second = await seedProject({ name: ' plaza ', color: 'rose', isActive: false, source: 'agent', agent_write_id: 'legacy' });

    const createResult = await createProject({ name: 'PLAZA', color: 'emerald', source: 'user', confirmRestore: true });
    const archiveResult = await archiveProject({ id: first.id! });

    assert.equal(createResult.outcome, 'conflict');
    assert.deepEqual(createResult.projects.map((project) => project.id).sort(), [first.id, second.id].sort());
    assert.equal(archiveResult.outcome, 'conflict');
    assert.deepEqual(await db.projects.toArray(), [first, second]);
});
