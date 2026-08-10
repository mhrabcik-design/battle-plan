/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import Dexie from 'dexie';

import { BattlePlanDB } from './db.ts';

const V9_STORES = {
    tasks: '++id, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
    settings: 'id',
    workLogs: '++id, date, projectId, hours, createdAt',
    projects: '++id, name, isActive, createdAt',
    agentInbox: 'id, action, entity_type, applied_at, received_at',
};

const V10_STORES = V9_STORES;

test('v10 upgrade reconciles duplicate projects and preserves WorkLog snapshots', async () => {
    const databaseName = `BattlePlanDB-v9-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(9).stores(V9_STORES);
    await legacy.open();

    const activeId = await legacy.table('projects').add({
        name: 'Komerční banka', color: 'indigo', isActive: true, createdAt: 10, updatedAt: 20,
    });
    const duplicateId = await legacy.table('projects').add({
        name: ' KOMERČNÍ BANKA ', color: 'rose', isActive: false, createdAt: 11, updatedAt: 30,
    });
    await legacy.table('workLogs').bulkAdd([
        {
            date: '2026-08-01', projectId: activeId, projectName: 'Komerční banka', people: 'Martin',
            hours: 2, source: 'manual', createdAt: 40, updatedAt: 40,
        },
        {
            date: '2026-08-02', projectId: duplicateId, projectName: ' KOMERČNÍ BANKA ', people: 'Petr',
            hours: 3, source: 'manual', createdAt: 50, updatedAt: 50,
        },
        {
            date: '2026-08-03', projectId: activeId, projectName: 'Historický název', people: 'Martin',
            hours: 1, source: 'manual', createdAt: 60, updatedAt: 60,
        },
    ]);
    await legacy.table('agentInbox').add({
        id: 'queued-project-update',
        action: 'update_project',
        entity_type: 'project',
        payload: {
            id: 'queued-project-update',
            action: 'update_project',
            project_data: { id: duplicateId, color: 'amber' },
            created_at: 70,
        },
        received_at: 70,
    });
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assert.equal(upgraded.verno, 12);
        assert.equal(await upgraded.projects.count(), 1);
        assert.deepEqual(
            (await upgraded.workLogs.orderBy('date').toArray()).map((workLog) => ({
                projectId: workLog.projectId,
                projectName: workLog.projectName,
            })),
            [
                { projectId: activeId, projectName: 'Komerční banka' },
                { projectId: activeId, projectName: ' KOMERČNÍ BANKA ' },
                { projectId: activeId, projectName: 'Historický název' },
            ],
        );
        const queued = await upgraded.agentInbox.get('queued-project-update');
        assert.deepEqual(
            (queued?.payload as { project_data?: { id?: number } }).project_data?.id,
            activeId,
        );
    } finally {
        await upgraded.delete();
    }
});

test('v11 upgrade backfills stable public identities without replacing local keys or sync identities', async () => {
    const databaseName = `BattlePlanDB-v10-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(10).stores(V10_STORES);
    await legacy.open();

    const projectId = await legacy.table('projects').add({
        name: 'Identity project', color: 'indigo', isActive: true, createdAt: 10, updatedAt: 10,
    });
    const taskId = await legacy.table('tasks').add({
        title: 'Identity task', type: 'task', urgency: 2, status: 'pending', createdAt: 20, updatedAt: 20,
    });
    const existingSyncId = 'worklog-existing-portable-id';
    const firstLogId = await legacy.table('workLogs').add({
        syncId: existingSyncId, date: '2026-08-09', projectId, projectName: 'Identity project',
        people: 'Martin', hours: 1, source: 'manual', createdAt: 30, updatedAt: 30,
    });
    const secondLogId = await legacy.table('workLogs').add({
        date: '2026-08-10', projectId, projectName: 'Identity project',
        people: 'Martin', hours: 2, source: 'manual', createdAt: 40, updatedAt: 40,
    });
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assert.equal(upgraded.verno, 12);
        const task = await upgraded.tasks.get(taskId);
        const project = await upgraded.projects.get(projectId);
        const logs = await upgraded.workLogs.orderBy('id').toArray();

        assert.equal(task?.id, taskId);
        assert.match(task?.publicId ?? '', /^task_[0-9a-f-]{36}$/);
        assert.equal(project?.id, projectId);
        assert.match(project?.publicId ?? '', /^project_[0-9a-f-]{36}$/);
        assert.deepEqual(logs.map((log) => log.id), [firstLogId, secondLogId]);
        assert.deepEqual(logs.map((log) => log.projectId), [projectId, projectId]);
        assert.equal(logs[0]?.syncId, existingSyncId);
        assert.match(logs[1]?.syncId ?? '', /^[0-9a-f-]{36}$/);
        assert.match(logs[0]?.publicId ?? '', /^worklog_[0-9a-f-]{36}$/);
        assert.match(logs[1]?.publicId ?? '', /^worklog_[0-9a-f-]{36}$/);
        assert.equal(new Set([task?.publicId, project?.publicId, ...logs.map((log) => log.publicId)]).size, 4);

        upgraded.close();
        const reopened = new BattlePlanDB(databaseName);
        await reopened.open();
        try {
            assert.equal((await reopened.tasks.get(taskId))?.publicId, task?.publicId);
            assert.equal((await reopened.projects.get(projectId))?.publicId, project?.publicId);
            assert.deepEqual((await reopened.workLogs.orderBy('id').toArray()).map((log) => log.syncId), logs.map((log) => log.syncId));
            assert.deepEqual((await reopened.workLogs.orderBy('id').toArray()).map((log) => log.publicId), logs.map((log) => log.publicId));

            const newTaskId = await reopened.tasks.add({
                title: 'Post-migration task', type: 'task', urgency: 2, status: 'pending',
                createdAt: 100, updatedAt: 100,
            });
            const generatedPublicId = (await reopened.tasks.get(newTaskId))?.publicId;
            assert.match(generatedPublicId ?? '', /^task_[0-9a-f-]{36}$/);
            await reopened.tasks.update(newTaskId, { publicId: 'attacker-replacement' });
            assert.equal((await reopened.tasks.get(newTaskId))?.publicId, generatedPublicId);

            await assert.rejects(reopened.tasks.add({
                title: 'Duplicate identity', publicId: generatedPublicId, type: 'task', urgency: 2,
                status: 'pending', createdAt: 101, updatedAt: 101,
            }));
            await assert.rejects(reopened.projects.add({
                name: 'Duplicate project identity', publicId: project?.publicId,
                color: 'slate', isActive: true, createdAt: 102, updatedAt: 102,
            }));
            await assert.rejects(reopened.workLogs.add({
                publicId: logs[0]?.publicId, syncId: 'independent-sync-id', date: '2026-08-11',
                projectId: Number(projectId), projectName: 'Identity project', people: 'Martin', hours: 3,
                source: 'manual', createdAt: 103, updatedAt: 103,
            }));
        } finally {
            reopened.close();
        }
    } finally {
        await Dexie.delete(databaseName);
    }
});
