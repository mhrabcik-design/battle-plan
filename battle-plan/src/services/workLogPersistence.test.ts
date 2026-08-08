/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db, type Project, type WorkLog } from '../db.ts';
import {
    addWorkLogsWithActiveProjects,
    updateWorkLogWithProjectSelection,
} from './workLogPersistence.ts';

async function resetDb(): Promise<void> {
    await db.workLogs.clear();
    await db.projects.clear();
}

async function seedProject(overrides: Partial<Project> = {}): Promise<Project> {
    const project: Project = {
        name: 'Plaza',
        color: 'slate',
        isActive: true,
        updatedAt: 20,
        createdAt: 10,
        ...overrides,
    };
    const id = await db.projects.add(project);
    return { ...project, id: id as number };
}

function draft(project: Project, overrides: Partial<WorkLog> = {}): Omit<WorkLog, 'id'> {
    return {
        date: '2026-08-08',
        projectId: project.id!,
        projectName: project.name,
        people: 'Martin',
        hours: 8,
        source: 'manual',
        updatedAt: 30,
        createdAt: 30,
        ...overrides,
    };
}

test('U3: active project validation snapshots the current catalog name on successful create', async () => {
    await resetDb();
    const active = await seedProject({ name: 'Plaza' });

    const [saved] = await addWorkLogsWithActiveProjects([
        draft(active, { projectName: '  PLAZA  ' }),
    ]);

    assert.equal(saved?.projectId, active.id);
    assert.equal(saved?.projectName, 'Plaza');
    assert.deepEqual(await db.workLogs.get(saved!.id!), saved);
});

test('U3: voice-style batch rejects one inactive project and rolls back every row', async () => {
    await resetDb();
    const active = await seedProject({ name: 'Active' });
    const archived = await seedProject({ name: 'Archived', isActive: false });

    await assert.rejects(
        addWorkLogsWithActiveProjects([
            draft(active),
            draft(archived, { date: '2026-08-09' }),
        ]),
        /project-not-found/,
    );

    assert.equal(await db.workLogs.count(), 0, 'the valid leading row must roll back with the batch');
});

test('U3: new entry rejects a stale device-local id/name pairing without a partial row', async () => {
    await resetDb();
    const unrelatedLocal = await seedProject({ name: 'Local project' });

    await assert.rejects(
        addWorkLogsWithActiveProjects([
            draft(unrelatedLocal, { projectName: 'Imported historical project' }),
        ]),
        /project-not-found/,
    );

    assert.equal(await db.workLogs.count(), 0);
});

test('U3: edit retains an unchanged imported historical assignment despite a local id collision', async () => {
    await resetDb();
    const collidingLocal = await seedProject({ name: 'Unrelated local project' });
    const original: WorkLog = draft(collidingLocal, {
        projectName: 'Imported historical project',
        people: 'Martin',
    });
    const id = await db.workLogs.add(original);

    const updated = await updateWorkLogWithProjectSelection({
        id: id as number,
        selectedProject: null,
        changes: { people: 'Martin, Sergej', updatedAt: 40 },
    });

    assert.equal(updated.projectId, collidingLocal.id);
    assert.equal(updated.projectName, 'Imported historical project');
    assert.equal(updated.people, 'Martin, Sergej');
});

test('U3: edit changing assignment rejects an inactive target without partial field updates', async () => {
    await resetDb();
    const originalProject = await seedProject({ name: 'Original', isActive: false });
    const archivedTarget = await seedProject({ name: 'Archived target', isActive: false });
    const original = draft(originalProject, { description: 'before' });
    const id = await db.workLogs.add(original);

    await assert.rejects(
        updateWorkLogWithProjectSelection({
            id: id as number,
            selectedProject: { id: archivedTarget.id!, name: archivedTarget.name },
            changes: { description: 'after', updatedAt: 50 },
        }),
        /project-not-found/,
    );

    assert.deepEqual(await db.workLogs.get(id), { ...original, id });
});

test('U3: edit changing assignment snapshots an active target inside the update transaction', async () => {
    await resetDb();
    const originalProject = await seedProject({ name: 'Original', isActive: false });
    const activeTarget = await seedProject({ name: 'Active target' });
    const id = await db.workLogs.add(draft(originalProject));

    const updated = await updateWorkLogWithProjectSelection({
        id: id as number,
        selectedProject: { id: activeTarget.id!, name: activeTarget.name },
        changes: { description: 'moved', updatedAt: 60 },
    });

    assert.equal(updated.projectId, activeTarget.id);
    assert.equal(updated.projectName, activeTarget.name);
    assert.equal(updated.description, 'moved');
});

test('manual-merge alias keeps an unchanged historical assignment valid on edit', async () => {
    await resetDb();
    const survivor = await seedProject({
        name: 'Komerční Banka',
        aliases: ['Komerční banka Plaza'],
        isActive: true,
    });
    const original = draft(survivor, {
        projectName: 'Komerční banka Plaza',
        description: 'before',
    });
    const id = await db.workLogs.add(original);

    const updated = await updateWorkLogWithProjectSelection({
        id: id as number,
        selectedProject: { id: survivor.id!, name: 'Komerční banka Plaza' },
        changes: { description: 'after', updatedAt: 50 },
    });

    assert.equal(updated.projectId, survivor.id);
    assert.equal(updated.projectName, 'Komerční banka Plaza');
    assert.equal(updated.description, 'after');
});
