/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db, type Project, type WorkLog } from '../db.ts';
import { reconcileProjectIdentities } from './projectIdentityReconciliation.ts';

async function resetDb(): Promise<void> {
    await db.workLogs.clear();
    await db.projects.clear();
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
    assert.deepEqual(await db.projects.get(activeId), {
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
