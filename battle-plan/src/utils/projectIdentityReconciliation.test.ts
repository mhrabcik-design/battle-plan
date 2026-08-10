/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db, type Project, type WorkLog } from '../db.ts';
import {
    ProjectIdentityConflictError,
    reconcileProjectIdentities,
} from './projectIdentityReconciliation.ts';

async function resetDb(): Promise<void> {
    await db.workLogs.clear();
    await db.projects.clear();
}

function withoutProjectPublicId(project: Project | undefined): Omit<Project, 'publicId'> | undefined {
    if (!project) return undefined;
    assert.match(project.publicId ?? '', /^project_[0-9a-f-]{36}$/);
    const legacyProject = { ...project };
    delete legacyProject.publicId;
    return legacyProject;
}

function withoutWorkLogPortableIds(
    workLog: WorkLog | undefined,
): Omit<WorkLog, 'publicId' | 'syncId'> | undefined {
    if (!workLog) return undefined;
    assert.match(workLog.publicId ?? '', /^worklog_[0-9a-f-]{36}$/);
    assert.match(workLog.syncId ?? '', /^[0-9a-f-]{36}$/);
    const legacyWorkLog = { ...workLog };
    delete legacyWorkLog.publicId;
    delete legacyWorkLog.syncId;
    return legacyWorkLog;
}

test('normalized project variants become one project and all WorkLogs use its identity', async () => {
    await resetDb();

    const activeId = await db.projects.add({
        name: 'Komerční banka',
        color: 'indigo',
        isActive: true,
        createdAt: 10,
        updatedAt: 20,
    });
    const duplicateId = await db.projects.add({
        name: '  KOMERČNÍ BANKA  ',
        color: 'rose',
        isActive: false,
        createdAt: 11,
        updatedAt: 30,
    });

    const variants = ['Komerční banka', ' komerční banka ', 'KOMERČNÍ BANKA', 'Komerční banka'];
    for (const [index, projectName] of variants.entries()) {
        const workLog: WorkLog = {
            date: '2026-08-08',
            projectId: index % 2 === 0 ? activeId : duplicateId,
            projectName,
            people: 'Martin',
            hours: 1,
            source: 'manual',
            createdAt: 100 + index,
            updatedAt: 100 + index,
        };
        await db.workLogs.add(workLog);
    }

    const result = await db.transaction('rw', [db.projects, db.workLogs], () => (
        reconcileProjectIdentities(db.projects, db.workLogs)
    ));

    assert.equal(result.projectsMerged, 1);
    assert.equal(result.workLogsRelinked, 2);
    assert.equal(await db.projects.count(), 1);
    assert.deepEqual(withoutProjectPublicId(await db.projects.get(activeId)), {
        id: activeId,
        name: 'Komerční banka',
        color: 'indigo',
        isActive: true,
        createdAt: 10,
        updatedAt: 30,
    });
    assert.deepEqual(
        (await db.workLogs.toArray()).map((workLog) => workLog.projectId),
        variants.map(() => activeId),
    );
});

test('a legacy WorkLog name without a catalog row creates one reusable project', async () => {
    await resetDb();
    const workLog: WorkLog = {
        date: '2026-08-08',
        projectId: 999,
        projectName: '  Komerční banka  ',
        people: 'Martin',
        hours: 4,
        source: 'manual',
        createdAt: 100,
        updatedAt: 120,
    };
    const workLogId = await db.workLogs.add(workLog);

    const result = await db.transaction('rw', [db.projects, db.workLogs], () => (
        reconcileProjectIdentities(db.projects, db.workLogs)
    ));

    assert.equal(result.projectsCreated, 1);
    const [project] = await db.projects.toArray() as Project[];
    assert.equal(project.name, 'Komerční banka');
    assert.equal(project.isActive, true);
    assert.equal(project.color, 'slate');
    assert.deepEqual(await db.workLogs.get(workLogId), {
        ...workLog,
        id: workLogId,
        projectId: project.id,
        projectName: workLog.projectName,
    });
});

test('a renamed historical snapshot keeps its existing project identity', async () => {
    await resetDb();
    const projectId = await db.projects.add({
        name: 'Nový název',
        color: 'emerald',
        isActive: true,
        createdAt: 10,
        updatedAt: 20,
    });
    const workLogId = await db.workLogs.add({
        date: '2026-08-08',
        projectId,
        projectName: 'Původní název',
        people: 'Martin',
        hours: 4,
        source: 'manual',
        createdAt: 30,
        updatedAt: 30,
    });

    const result = await db.transaction('rw', [db.projects, db.workLogs], () => (
        reconcileProjectIdentities(db.projects, db.workLogs)
    ));

    assert.equal(result.projectsCreated, 0);
    assert.equal(await db.projects.count(), 1);
    assert.equal((await db.workLogs.get(workLogId))?.projectId, projectId);
    assert.equal((await db.workLogs.get(workLogId))?.projectName, 'Původní název');
});

test('an absorbed canonical project collapses into its alias owner without replacing survivor metadata', async () => {
    await resetDb();
    const survivorId = await db.projects.add({
        name: 'Komerční Banka',
        aliases: ['  KOMERČNÍ banka Plaza ', 'KB Plaza'],
        color: 'indigo',
        isActive: true,
        source: 'user',
        createdAt: 10,
        updatedAt: 100,
    });
    const staleSourceId = await db.projects.add({
        name: 'Komerční banka Plaza',
        aliases: ['KB LIBEREC', null, 42, ''] as unknown as string[],
        color: 'rose',
        isActive: false,
        source: 'agent',
        createdAt: 20,
        updatedAt: 999,
    });
    const workLogId = await db.workLogs.add({
        date: '2026-08-08', projectId: staleSourceId, projectName: 'Komerční banka Plaza',
        people: 'Martin', hours: 2, source: 'manual', createdAt: 30, updatedAt: 30,
    });

    const result = await db.transaction('rw', [db.projects, db.workLogs], () => (
        reconcileProjectIdentities(db.projects, db.workLogs)
    ));

    assert.equal(result.projectsMerged, 1);
    assert.equal(result.workLogsRelinked, 1);
    assert.deepEqual(withoutProjectPublicId(await db.projects.get(survivorId)), {
        id: survivorId,
        name: 'Komerční Banka',
        aliases: ['KB LIBEREC', 'KB Plaza', 'Komerční banka Plaza'],
        color: 'indigo',
        isActive: true,
        source: 'user',
        createdAt: 10,
        updatedAt: 100,
    });
    assert.equal(await db.projects.get(staleSourceId), undefined);
    assert.deepEqual(withoutWorkLogPortableIds(await db.workLogs.get(workLogId)), {
        id: workLogId,
        date: '2026-08-08', projectId: survivorId, projectName: 'Komerční banka Plaza',
        people: 'Martin', hours: 2, source: 'manual', createdAt: 30, updatedAt: 30,
    });
});

test('acyclic alias chains collapse deterministically and are idempotent', async () => {
    await resetDb();
    const rootId = await db.projects.add({
        name: 'A', aliases: ['B'], color: 'indigo', isActive: true, createdAt: 1, updatedAt: 10,
    });
    const middleId = await db.projects.add({
        name: 'B', aliases: ['C'], color: 'rose', isActive: true, createdAt: 2, updatedAt: 20,
    });
    const leafId = await db.projects.add({
        name: 'C', aliases: ['D'], color: 'slate', isActive: false, createdAt: 3, updatedAt: 30,
    });

    const first = await db.transaction('rw', [db.projects, db.workLogs], () => (
        reconcileProjectIdentities(db.projects, db.workLogs)
    ));
    const afterFirst = (await db.projects.toArray()).map(withoutProjectPublicId);
    const second = await db.transaction('rw', [db.projects, db.workLogs], () => (
        reconcileProjectIdentities(db.projects, db.workLogs)
    ));

    assert.deepEqual(first.projectIdRemaps, new Map([[middleId, rootId], [leafId, rootId]]));
    assert.equal(first.projectsMerged, 2);
    assert.deepEqual(afterFirst, [{
        id: rootId,
        name: 'A',
        aliases: ['B', 'C', 'D'],
        color: 'indigo',
        isActive: true,
        createdAt: 1,
        updatedAt: 10,
    }]);
    assert.equal(second.projectsMerged, 0);
    assert.deepEqual((await db.projects.toArray()).map(withoutProjectPublicId), afterFirst);
});

test('cyclic or competing alias ownership fails closed without partial writes', async () => {
    await resetDb();
    await db.projects.bulkAdd([
        { name: 'A', aliases: ['B'], color: 'indigo', isActive: true, createdAt: 1, updatedAt: 1 },
        { name: 'B', aliases: ['A'], color: 'rose', isActive: true, createdAt: 2, updatedAt: 2 },
    ]);
    const beforeCycle = await db.projects.toArray();

    await assert.rejects(
        db.transaction('rw', [db.projects, db.workLogs], () => (
            reconcileProjectIdentities(db.projects, db.workLogs)
        )),
        ProjectIdentityConflictError,
    );
    assert.deepEqual(await db.projects.toArray(), beforeCycle);

    await resetDb();
    await db.projects.bulkAdd([
        { name: 'A', aliases: ['Shared'], color: 'indigo', isActive: true, createdAt: 1, updatedAt: 1 },
        { name: 'B', aliases: [' shared '], color: 'rose', isActive: true, createdAt: 2, updatedAt: 2 },
    ]);
    const beforeCompetition = await db.projects.toArray();

    await assert.rejects(
        db.transaction('rw', [db.projects, db.workLogs], () => (
            reconcileProjectIdentities(db.projects, db.workLogs)
        )),
        ProjectIdentityConflictError,
    );
    assert.deepEqual(await db.projects.toArray(), beforeCompetition);
});
