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
        assert.equal(upgraded.verno, 10);
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
