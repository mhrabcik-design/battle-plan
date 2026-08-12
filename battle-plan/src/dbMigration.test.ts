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

const V11_STORES = {
    tasks: '++id, publicId, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
    settings: 'id',
    workLogs: '++id, publicId, syncId, date, projectId, hours, createdAt',
    projects: '++id, publicId, name, isActive, createdAt',
    agentInbox: 'id, action, entity_type, applied_at, received_at',
    agentCommandReceipts: 'id, commandId, receiverId, lifecycle, leaseExpiresAt, retainUntil, updatedAt',
    agentCommandReceiptHistory: 'id, receiptId, entryIndex, lifecycle, at',
    agentCommandConflicts: 'id, commandId, receiverId, createdAt, retainUntil',
    agentEventStreams: 'streamId, producerId, updatedAt',
    agentProtocolEvents: 'id, eventId, streamId, producerId, entityKind, entityPublicId, createdAt, publishedAt',
    agentProtocolOutbox: 'id, family, messageId, commandReceiptId, status, nextAttemptAt, createdAt',
    agentProtocolEffects: 'id, commandReceiptId, kind, state, nextAttemptAt, updatedAt',
    agentConsumerStates: 'id, consumerId, streamId, requiresSnapshot, inactiveAfter, updatedAt',
    agentSigningKeyRefs: 'keyId, receiverId, pairingEpoch, status, updatedAt',
    agentPairingKeys: 'id, workspaceId, producerId, receiverId, keyId, pairingEpoch, status, retainUntil',
    agentReceiverCapabilities: 'receiverId, enabled, status, persistenceStatus, updatedAt',
};

const LEGACY_V13_UNIQUE_STORES = {
    ...V11_STORES,
    tasks: '++id, &publicId, type, date, deadline, urgency, status, googleEventId, updatedAt, isDeleted, createdAt',
    workLogs: '++id, &publicId, syncId, date, projectId, hours, createdAt',
    projects: '++id, &publicId, name, isActive, createdAt',
};

const assertPortableIdentityIndexesAreUnique = (db: BattlePlanDB): void => {
    assert.equal(db.tasks.schema.idxByName.publicId?.unique, true);
    assert.equal(db.projects.schema.idxByName.publicId?.unique, true);
    assert.equal(db.workLogs.schema.idxByName.publicId?.unique, true);
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
        assert.equal(upgraded.verno, 17);
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
        assert.equal(upgraded.verno, 17);
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
        assert.match(logs[1]?.syncId ?? '', /^legacy-[0-9a-f]{32}$/);
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

test('direct v11 upgrade repairs duplicate public identities before creating unique indexes', async () => {
    const databaseName = `BattlePlanDB-v11-duplicate-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(11).stores(V11_STORES);
    await legacy.open();

    const projectIds = await legacy.table('projects').bulkAdd([
        { name: 'Existing project', publicId: 'project_keep', isActive: true, createdAt: 10 },
        { name: 'Duplicate project A', publicId: 'project_duplicate', isActive: true, createdAt: 11 },
        { name: 'Duplicate project B', publicId: 'project_duplicate', isActive: true, createdAt: 12 },
    ], { allKeys: true }) as number[];
    const taskIds = await legacy.table('tasks').bulkAdd([
        { title: 'Existing task', publicId: 'task_keep', type: 'task', urgency: 2, status: 'pending', createdAt: 20 },
        { title: 'Duplicate task A', publicId: 'task_duplicate', type: 'task', urgency: 2, status: 'pending', createdAt: 21 },
        { title: 'Duplicate task B', publicId: 'task_duplicate', type: 'task', urgency: 2, status: 'pending', createdAt: 22 },
    ], { allKeys: true }) as number[];
    const workLogIds = await legacy.table('workLogs').bulkAdd([
        {
            publicId: 'worklog_keep', syncId: 'sync-keep', date: '2026-08-10', projectId: projectIds[0],
            projectName: 'Existing project', people: 'Martin', hours: 1, source: 'manual', createdAt: 30,
        },
        {
            publicId: 'worklog_duplicate', syncId: 'sync-a', date: '2026-08-11', projectId: projectIds[0],
            projectName: 'Existing project', people: 'Martin', hours: 2, source: 'manual', createdAt: 31,
        },
        {
            publicId: 'worklog_duplicate', syncId: 'sync-b', date: '2026-08-12', projectId: projectIds[0],
            projectName: 'Existing project', people: 'Martin', hours: 3, source: 'manual', createdAt: 32,
        },
    ], { allKeys: true }) as number[];
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assert.equal(upgraded.verno, 17);
        const projects = await upgraded.projects.orderBy('id').toArray();
        const tasks = await upgraded.tasks.orderBy('id').toArray();
        const workLogs = await upgraded.workLogs.orderBy('id').toArray();

        assert.deepEqual(projects.map((row) => row.id), projectIds);
        assert.deepEqual(tasks.map((row) => row.id), taskIds);
        assert.deepEqual(workLogs.map((row) => row.id), workLogIds);
        assert.equal(projects[0]?.publicId, 'project_keep');
        assert.equal(tasks[0]?.publicId, 'task_keep');
        assert.equal(workLogs[0]?.publicId, 'worklog_keep');
        assert.deepEqual(workLogs.map((row) => row.syncId), ['sync-keep', 'sync-a', 'sync-b']);
        assert.equal(new Set(projects.map((row) => row.publicId)).size, projects.length);
        assert.equal(new Set(tasks.map((row) => row.publicId)).size, tasks.length);
        assert.equal(new Set(workLogs.map((row) => row.publicId)).size, workLogs.length);
    } finally {
        await upgraded.delete();
    }
});

test('direct v12 upgrade repairs missing portable identities before enforcing unique indexes', async () => {
    const databaseName = `BattlePlanDB-v12-missing-identity-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(12).stores(V11_STORES);
    await legacy.open();

    const projectIds = await legacy.table('projects').bulkAdd([
        { name: 'Missing identity project', isActive: true, createdAt: 10 },
        { name: 'Duplicate v12 project A', publicId: 'project_v12_duplicate', isActive: true, createdAt: 11 },
        { name: 'Duplicate v12 project B', publicId: 'project_v12_duplicate', isActive: true, createdAt: 12 },
    ], { allKeys: true }) as number[];
    const taskIds = await legacy.table('tasks').bulkAdd([
        { title: 'Missing identity task', type: 'task', urgency: 2, status: 'pending', createdAt: 20 },
        { title: 'Duplicate v12 task A', publicId: 'task_v12_duplicate', type: 'task', urgency: 2, status: 'pending', createdAt: 21 },
        { title: 'Duplicate v12 task B', publicId: 'task_v12_duplicate', type: 'task', urgency: 2, status: 'pending', createdAt: 22 },
    ], { allKeys: true }) as number[];
    const workLogIds = await legacy.table('workLogs').bulkAdd([
        {
            syncId: 'preserve-existing-sync-id', date: '2026-08-11', projectId: projectIds[0],
            projectName: 'Missing identity project', people: 'Martin', hours: 1,
            source: 'manual', createdAt: 30,
        },
        {
            publicId: 'worklog_v12_duplicate', syncId: 'sync-v12-a', date: '2026-08-12', projectId: projectIds[0],
            projectName: 'Missing identity project', people: 'Martin', hours: 2,
            source: 'manual', createdAt: 31,
        },
        {
            publicId: 'worklog_v12_duplicate', syncId: 'sync-v12-b', date: '2026-08-13', projectId: projectIds[0],
            projectName: 'Missing identity project', people: 'Martin', hours: 3,
            source: 'manual', createdAt: 32,
        },
    ], { allKeys: true }) as number[];
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assertPortableIdentityIndexesAreUnique(upgraded);
        const projects = await upgraded.projects.orderBy('id').toArray();
        const tasks = await upgraded.tasks.orderBy('id').toArray();
        const workLogs = await upgraded.workLogs.orderBy('id').toArray();
        assert.deepEqual(projects.map((project) => project.id), projectIds);
        assert.deepEqual(tasks.map((task) => task.id), taskIds);
        assert.deepEqual(workLogs.map((workLog) => workLog.id), workLogIds);
        assert.equal(new Set(projects.map((project) => project.publicId)).size, projects.length);
        assert.equal(new Set(tasks.map((task) => task.publicId)).size, tasks.length);
        assert.equal(new Set(workLogs.map((workLog) => workLog.publicId)).size, workLogs.length);
        assert.deepEqual(workLogs.map((workLog) => workLog.syncId), [
            'preserve-existing-sync-id', 'sync-v12-a', 'sync-v12-b',
        ]);

        const identitySnapshot = {
            projects: projects.map((project) => project.publicId),
            tasks: tasks.map((task) => task.publicId),
            workLogs: workLogs.map((workLog) => workLog.publicId),
        };
        upgraded.close();
        const reopened = new BattlePlanDB(databaseName);
        await reopened.open();
        try {
            assertPortableIdentityIndexesAreUnique(reopened);
            assert.deepEqual((await reopened.projects.orderBy('id').toArray()).map((row) => row.publicId), identitySnapshot.projects);
            assert.deepEqual((await reopened.tasks.orderBy('id').toArray()).map((row) => row.publicId), identitySnapshot.tasks);
            assert.deepEqual((await reopened.workLogs.orderBy('id').toArray()).map((row) => row.publicId), identitySnapshot.workLogs);
        } finally {
            reopened.close();
        }
    } finally {
        await Dexie.delete(databaseName);
    }
});

test('direct v13 upgrade repairs identities omitted under the previous unique schema', async () => {
    const databaseName = `BattlePlanDB-v13-missing-identity-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(13).stores(LEGACY_V13_UNIQUE_STORES);
    await legacy.open();

    const taskIds = await legacy.table('tasks').bulkAdd([
        { title: 'First missing identity', type: 'task', urgency: 2, status: 'pending', createdAt: 10 },
        { title: 'Second missing identity', type: 'task', urgency: 2, status: 'pending', createdAt: 20 },
    ], { allKeys: true }) as number[];
    const projectIds = await legacy.table('projects').bulkAdd([
        { name: 'First missing identity project', isActive: true, createdAt: 30 },
        { name: 'Second missing identity project', isActive: true, createdAt: 31 },
    ], { allKeys: true }) as number[];
    const workLogIds = await legacy.table('workLogs').bulkAdd([
        {
            syncId: 'legacy-v13-sync-a', date: '2026-08-11', projectId: projectIds[0],
            projectName: 'First missing identity project', people: 'Martin', hours: 1,
            source: 'manual', createdAt: 40,
        },
        {
            syncId: 'legacy-v13-sync-b', date: '2026-08-12', projectId: projectIds[1],
            projectName: 'Second missing identity project', people: 'Martin', hours: 2,
            source: 'manual', createdAt: 41,
        },
    ], { allKeys: true }) as number[];
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assert.equal(upgraded.verno, 17);
        assertPortableIdentityIndexesAreUnique(upgraded);
        const tasks = await upgraded.tasks.orderBy('id').toArray();
        const projects = await upgraded.projects.orderBy('id').toArray();
        const workLogs = await upgraded.workLogs.orderBy('id').toArray();
        assert.deepEqual(tasks.map((task) => task.id), taskIds);
        assert.deepEqual(projects.map((project) => project.id), projectIds);
        assert.deepEqual(workLogs.map((workLog) => workLog.id), workLogIds);
        assert.equal(new Set(tasks.map((task) => task.publicId)).size, tasks.length);
        assert.equal(new Set(projects.map((project) => project.publicId)).size, projects.length);
        assert.equal(new Set(workLogs.map((workLog) => workLog.publicId)).size, workLogs.length);
        assert.deepEqual(workLogs.map((workLog) => workLog.syncId), ['legacy-v13-sync-a', 'legacy-v13-sync-b']);
        for (const task of tasks) assert.match(task.publicId ?? '', /^task_[0-9a-f-]{36}$/);
        for (const project of projects) assert.match(project.publicId ?? '', /^project_[0-9a-f-]{36}$/);
        for (const workLog of workLogs) assert.match(workLog.publicId ?? '', /^worklog_[0-9a-f-]{36}$/);
    } finally {
        await upgraded.delete();
    }
});

test('an aborted v14 identity repair rolls back and succeeds on retry', async () => {
    const databaseName = `BattlePlanDB-v14-repair-rollback-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(12).stores(V11_STORES);
    await legacy.open();
    const taskId = await legacy.table('tasks').add({
        title: 'Rollback identity task', type: 'task', urgency: 2, status: 'pending', createdAt: 10,
    });
    legacy.close();

    const failingUpgrade = new BattlePlanDB(databaseName);
    failingUpgrade.tasks.hook('updating', () => {
        throw new Error('injected portable identity repair failure');
    });
    await assert.rejects(failingUpgrade.open(), /injected portable identity repair failure/);
    failingUpgrade.close();

    const inspector = new Dexie(databaseName);
    inspector.version(12).stores(V11_STORES);
    await inspector.open();
    try {
        assert.equal(inspector.verno, 12);
        assert.equal((await inspector.table('tasks').get(taskId) as { publicId?: string }).publicId, undefined);
    } finally {
        inspector.close();
    }

    const recovered = new BattlePlanDB(databaseName);
    await recovered.open();
    try {
        assert.equal(recovered.verno, 17);
        assert.match((await recovered.tasks.get(taskId))?.publicId ?? '', /^task_[0-9a-f-]{36}$/);
        assertPortableIdentityIndexesAreUnique(recovered);
    } finally {
        await recovered.delete();
    }
});

test('v16 upgrade makes legacy command receipts without authenticated expiry fail closed', async () => {
    const databaseName = `BattlePlanDB-v15-command-expiry-upgrade-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(15).stores(LEGACY_V13_UNIQUE_STORES);
    await legacy.open();
    const receiptId = ['battleplan-receiver-a', '018f6f5e-2d88-7f2a-8f90-d6ad23000401'].join('\0');
    await legacy.table('agentCommandReceipts').add({
        id: receiptId,
        commandId: '018f6f5e-2d88-7f2a-8f90-d6ad23000401',
        payloadDigest: `sha256:${'a'.repeat(64)}`,
        producerId: 'hermes',
        receiverId: 'battleplan-receiver-a',
        lifecycle: 'executing',
        effectState: 'none',
        leaseOwner: 'legacy-owner',
        leaseExpiresAt: 5_000,
        fencingToken: 1,
        attempts: 1,
        historyCount: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        retainUntil: 10_000,
    });
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assert.equal(upgraded.verno, 17);
        assert.equal((await upgraded.agentCommandReceipts.get(receiptId))?.commandExpiresAt, 0);
    } finally {
        await upgraded.delete();
    }
});

test('legacy WorkLog backfill assigns the same sync identity on independent devices', async () => {
    const databaseNames = [0, 1].map((index) => (
        `BattlePlanDB-v10-cross-device-${Date.now()}-${index}-${Math.random()}`
    ));
    const syncIds: string[] = [];

    try {
        for (const databaseName of databaseNames) {
            const legacy = new Dexie(databaseName);
            legacy.version(10).stores(V10_STORES);
            await legacy.open();
            const projectId = await legacy.table('projects').add({
                name: 'Komerční Banka', color: 'amber', isActive: true,
                createdAt: 10, updatedAt: 10,
            });
            await legacy.table('workLogs').add({
                date: '2026-06-22', projectId, projectName: 'Komerční Banka',
                people: 'Martin, Sergej, Sergejův bratr', hours: 30,
                source: 'voice', createdAt: 20, updatedAt: 20,
            });
            legacy.close();

            const upgraded = new BattlePlanDB(databaseName);
            await upgraded.open();
            syncIds.push((await upgraded.workLogs.toArray())[0]?.syncId ?? '');
            upgraded.close();
        }

        assert.match(syncIds[0] ?? '', /^legacy-[0-9a-f]{32}$/);
        assert.equal(syncIds[0], syncIds[1]);
    } finally {
        for (const databaseName of databaseNames) await Dexie.delete(databaseName);
    }
});

test('legacy upgrade preserves intentionally identical rows with deterministic distinct sync identities', async () => {
    const databaseName = `BattlePlanDB-v13-identical-worklogs-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(13).stores(LEGACY_V13_UNIQUE_STORES);
    await legacy.open();
    const projectId = await legacy.table('projects').add({
        publicId: 'project_kb', name: 'Komerční Banka', color: 'amber', isActive: true,
        createdAt: 10, updatedAt: 10,
    });
    const sharedFields = {
        date: '2026-06-22', projectId, projectName: 'Komerční Banka',
        people: 'Martin, Sergej, Sergejův bratr', hours: 30, source: 'voice', createdAt: 20,
    };
    await legacy.table('workLogs').bulkAdd([
        { ...sharedFields, extractionBatchId: 'voice-20', updatedAt: 20 },
        { ...sharedFields, extractionBatchId: 'voice-20', updatedAt: 20 },
    ]);
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assert.equal(upgraded.verno, 17);
        const workLogs = await upgraded.workLogs.toArray();
        assert.equal(workLogs.length, 2);
        assert.match(workLogs[0]?.syncId ?? '', /^legacy-[0-9a-f]{32}$/);
        assert.equal(workLogs[1]?.syncId, `${workLogs[0]?.syncId}-2`);
        assert.equal(workLogs.reduce((sum, workLog) => sum + workLog.hours, 0), 60);
    } finally {
        await upgraded.delete();
    }
});

test('v17 adds the suggestion decision registry without changing existing task keys', async () => {
    const databaseName = `BattlePlanDB-v16-suggestion-registry-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(16).stores(LEGACY_V13_UNIQUE_STORES);
    await legacy.open();
    const existingTaskId = await legacy.table('tasks').add({
        publicId: 'task_existing', title: 'Existing task', type: 'task', urgency: 2,
        status: 'pending', createdAt: 10, updatedAt: 10,
    });
    legacy.close();

    const upgraded = new BattlePlanDB(databaseName);
    await upgraded.open();
    try {
        assert.equal(upgraded.verno, 17);
        assert.equal((await upgraded.tasks.get(existingTaskId))?.publicId, 'task_existing');
        assert.equal(upgraded.tasks.schema.idxByName.suggestionOccurrenceKey?.unique, true);
        assert.ok(upgraded.tables.some((table) => table.name === 'suggestionSubjects'));
        assert.ok(upgraded.tables.some((table) => table.name === 'suggestionOccurrences'));
        assert.ok(upgraded.tables.some((table) => table.name === 'suggestionDecisions'));

        const convertedTask = {
            publicId: 'task_converted', suggestionSubjectId: 'subject-tax',
            suggestionOccurrenceKey: 'occurrence-tax-2026-07', title: 'DPH 7/26',
            type: 'task', urgency: 2, status: 'pending', createdAt: 20, updatedAt: 20,
        } as const;
        await upgraded.tasks.add(convertedTask);
        await assert.rejects(upgraded.tasks.add({
            ...convertedTask,
            publicId: 'task_duplicate-conversion',
        }));
        await upgraded.tasks.bulkAdd([
            { publicId: 'task_regular-a', title: 'Regular A', type: 'task', urgency: 2, status: 'pending', createdAt: 30, updatedAt: 30 },
            { publicId: 'task_regular-b', title: 'Regular B', type: 'task', urgency: 2, status: 'pending', createdAt: 31, updatedAt: 31 },
        ]);
    } finally {
        await upgraded.delete();
    }
});
