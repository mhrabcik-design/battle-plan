/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BattlePlanDB, type Task } from '../db.ts';
import { AgentProtocolLedger } from './agentProtocol/ledger.ts';
import { calendarEffectsForLocalTask, TaskMutationService } from './taskMutations.ts';

const CAUSES = {
    ui: '018f6f5e-2d88-7f2a-8f90-d6ad23001001',
    voice: '018f6f5e-2d88-7f2a-8f90-d6ad23001002',
    hermes: '018f6f5e-2d88-7f2a-8f90-d6ad23001003',
    drive: '018f6f5e-2d88-7f2a-8f90-d6ad23001004',
} as const;

function task(title = 'Atomic task'): Omit<Task, 'id' | 'publicId' | 'protocolRevision' | 'createdAt' | 'updatedAt'> {
    return { title, description: 'Visible detail', internalNotes: 'PRIVATE RAW TRANSCRIPT', type: 'task', urgency: 2, status: 'pending' };
}

async function database(t: { after: (fn: () => Promise<void>) => void }): Promise<BattlePlanDB> {
    const db = new BattlePlanDB(`TaskMutations-${crypto.randomUUID()}`);
    await db.open();
    t.after(async () => db.delete());
    return db;
}

test('linked Calendar effects stay durable while immediate execution is unavailable', () => {
    const linkedMeeting = { type: 'meeting' as const, googleEventId: 'calendar-event-1' };
    assert.deepEqual(calendarEffectsForLocalTask(linkedMeeting, 'upsert'), [
        { kind: 'calendar', operation: 'upsert' },
    ]);
    assert.deepEqual(calendarEffectsForLocalTask(linkedMeeting, 'delete'), [
        { kind: 'calendar', operation: 'delete' },
    ]);
    assert.deepEqual(calendarEffectsForLocalTask({ type: 'task', googleEventId: 'calendar-event-legacy' }, 'upsert'), [
        { kind: 'calendar', operation: 'upsert' },
    ]);

    const unlinkedMeeting = { type: 'meeting' as const, googleEventId: undefined };
    assert.deepEqual(calendarEffectsForLocalTask(unlinkedMeeting, 'upsert'), []);
    assert.deepEqual(calendarEffectsForLocalTask(unlinkedMeeting, 'upsert', true), [
        { kind: 'calendar', operation: 'upsert' },
    ]);
    assert.deepEqual(calendarEffectsForLocalTask(unlinkedMeeting, 'delete', true), []);
});

test('UI, voice, Hermes and Drive imports emit equivalent safe Task state with distinct context', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => Date.parse('2026-08-11T08:00:00Z') });

    for (const origin of ['ui', 'voice', 'hermes', 'drive'] as const) {
        const context = { actor: origin === 'hermes' ? 'hermes-agent' : 'battleplan-user', origin, causeId: CAUSES[origin] } as const;
        const result = origin === 'drive'
            ? await service.importTask({
                task: { ...task('Task from drive'), createdAt: 10, updatedAt: 20 },
                context,
            })
            : await service.createTask({ task: task(`Task from ${origin}`), context });
        assert.equal(result.status, 'applied');
    }

    const tasks = await db.tasks.toArray();
    const events = (await db.agentProtocolEvents.toArray()).sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)));
    assert.equal(tasks.length, 4);
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((event) => event.origin), ['ui', 'voice', 'hermes', 'drive']);
    assert.deepEqual(events.map((event) => event.causeId), Object.values(CAUSES));
    for (const [index, event] of events.entries()) {
        assert.equal(event.entityPublicId, tasks[index]!.publicId);
        assert.equal(event.revision.revision_id, tasks[index]!.protocolRevision?.revision_id);
        assert.equal(event.projection.title, tasks[index]!.title);
        assert.equal('id' in event.projection, false);
        assert.equal('internalNotes' in event.projection, false);
        assert.equal('agent_write_id' in event.projection, false);
    }
    assert.equal(await db.agentProtocolOutbox.where('family').equals('event').count(), 4);
});

test('Drive import never overwrites an unrelated Task that shares only a numeric local ID', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const localId = await db.tasks.add({
        publicId: 'task_local_identity', title: 'Local task', type: 'task', urgency: 2, status: 'pending', createdAt: 1, updatedAt: 10,
    });

    const imported = await service.importTask({
        task: {
            id: localId,
            publicId: 'task_remote_identity',
            title: 'Remote task', type: 'task', urgency: 2, status: 'pending', createdAt: 2, updatedAt: 20,
        },
        context: { actor: 'battleplan-drive', origin: 'drive', causeId: CAUSES.drive },
    });

    assert.equal(imported.status, 'applied');
    assert.equal(await db.tasks.count(), 2);
    assert.equal((await db.tasks.get(localId))?.title, 'Local task');
    assert.equal((await db.tasks.where('publicId').equals('task_remote_identity').first())?.title, 'Remote task');
});

test('Task, event, effect and event outbox roll back as one transaction', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, {
        now: () => Date.parse('2026-08-11T08:00:00Z'),
        beforeCommit: () => { throw new Error('injected-before-commit'); },
    });

    await assert.rejects(service.createTask({
        task: { ...task('Meeting'), type: 'meeting' },
        context: { actor: 'battleplan-user', origin: 'voice', causeId: CAUSES.voice },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    }), /injected-before-commit/);

    assert.equal(await db.tasks.count(), 0);
    assert.equal(await db.agentProtocolEvents.count(), 0);
    assert.equal(await db.agentProtocolOutbox.count(), 0);
    assert.equal(await db.agentProtocolEffects.count(), 0);
    assert.equal(await db.agentEventStreams.count(), 0);
});

test('expected revision mismatch is stale and changes no durable state', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => Date.parse('2026-08-11T08:00:00Z') });
    const created = await service.createTask({
        task: task(),
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');
    const countsBefore = {
        tasks: await db.tasks.count(), events: await db.agentProtocolEvents.count(), outbox: await db.agentProtocolOutbox.count(),
    };

    const stale = await service.updateTask({
        publicId: created.task.publicId!,
        expectedRevision: `sha256:${'f'.repeat(64)}`,
        changes: { title: 'Must not win' },
        context: { actor: 'hermes-agent', origin: 'hermes', causeId: CAUSES.hermes },
    });

    assert.equal(stale.status, 'stale');
    assert.equal((await db.tasks.get(created.task.id!))?.title, 'Atomic task');
    assert.deepEqual({
        tasks: await db.tasks.count(), events: await db.agentProtocolEvents.count(), outbox: await db.agentProtocolOutbox.count(),
    }, countsBefore);
});

test('caller-owned update input is snapshotted before the first asynchronous read', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const created = await service.createTask({
        task: task('Original title'),
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');
    const changes: Partial<Task> = { title: 'Submitted title' };
    const context = { actor: 'battleplan-user', origin: 'ui' as const, causeId: CAUSES.voice };

    const pending = service.updateTask({ localId: created.task.id, changes, context });
    changes.title = 'Attacker-raced title';
    context.actor = 'attacker-raced-actor';

    const result = await pending;
    assert.equal(result.status, 'applied');
    if (result.status !== 'applied') return;
    assert.equal(result.task.title, 'Submitted title');
    const event = await db.agentProtocolEvents.where('entityPublicId').equals(result.task.publicId!).last();
    assert.equal(event?.actor, 'battleplan-user');
});

test('concurrent Calendar metadata completion is preserved by a Task update', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const created = await service.createTask({
        task: { ...task('Linked meeting'), type: 'meeting' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');
    if (created.status !== 'applied') return;

    const taskReader = db.tasks as unknown as { get: (key: number) => Promise<Task | undefined> };
    const originalGet = taskReader.get.bind(db.tasks);
    let releaseFirstRead!: () => void;
    let firstReadDone!: () => void;
    const firstRead = new Promise<void>((resolve) => { firstReadDone = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    let intercept = true;
    taskReader.get = async (key: number) => {
        const value = await originalGet(key);
        if (intercept) {
            intercept = false;
            firstReadDone();
            await gate;
        }
        return value;
    };

    const pending = service.updateTask({
        localId: created.task.id,
        changes: { title: 'Edited while Calendar completes' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.voice },
    });
    await firstRead;
    await db.tasks.update(created.task.id!, { googleEventId: 'calendar-event-raced' });
    releaseFirstRead();
    const result = await pending;
    taskReader.get = originalGet;

    assert.equal(result.status, 'applied');
    assert.equal((await db.tasks.get(created.task.id!))?.googleEventId, 'calendar-event-raced');
});

test('overlapping manual sync requests share one active durable effect', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const created = await service.createTask({
        task: { ...task('Manual sync'), type: 'meeting' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');

    const [first, second] = await Promise.all([
        service.queueEffects({
            publicId: created.task.publicId,
            context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
            effects: [{ kind: 'calendar', operation: 'upsert' }],
        }),
        service.queueEffects({
            publicId: created.task.publicId,
            context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.voice },
            effects: [{ kind: 'calendar', operation: 'upsert' }],
        }),
    ]);

    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    assert.equal(await db.agentProtocolEffects.count(), 1);
    if (first.status === 'queued' && second.status === 'queued') assert.deepEqual(first.effectIds, second.effectIds);
});

test('a fenced Hermes command commits receipt, Task, event, result and effect atomically', async (t) => {
    const db = await database(t);
    const now = 1_000;
    await db.agentReceiverCapabilities.put({
        receiverId: 'battleplan-receiver-a', enabled: true, status: 'ready', persistenceStatus: 'granted', updatedAt: now,
    });
    const ledger = new AgentProtocolLedger(db, () => now);
    const claimed = await ledger.claimCommand({
        commandId: '018f6f5e-2d88-7f2a-8f90-d6ad23001010',
        payloadDigest: `sha256:${'a'.repeat(64)}`,
        producerId: 'hermes-agent',
        targetReceiverId: 'battleplan-receiver-a',
        localReceiverId: 'battleplan-receiver-a',
        expiresAt: 10_000,
        leaseOwner: 'tab-a',
        leaseDurationMs: 5_000,
    });
    assert.equal(claimed.status, 'claimed');
    if (claimed.status !== 'claimed') return;
    const service = new TaskMutationService(db, { now: () => now });

    const result = await service.createTask({
        task: { ...task('Hermes meeting'), type: 'meeting' },
        context: { actor: 'hermes-agent', origin: 'hermes', causeId: CAUSES.hermes },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
        command: { ledger, claim: claimed.claim },
    });

    assert.equal(result.status, 'applied');
    assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'applied');
    assert.equal(await db.tasks.count(), 1);
    assert.equal(await db.agentProtocolEvents.count(), 1);
    assert.equal(await db.agentProtocolEffects.count(), 1);
    assert.equal(await db.agentProtocolOutbox.where('family').equals('result').count(), 1);
    assert.equal(await db.agentProtocolOutbox.where('family').equals('event').count(), 1);
    const effect = await db.agentProtocolEffects.toCollection().first();
    assert.equal(effect?.commandReceiptId, claimed.claim.receiptId);
});

test('a stale fenced Hermes update finalizes its receipt without Task or event mutation', async (t) => {
    const db = await database(t);
    const now = 1_000;
    const service = new TaskMutationService(db, { now: () => now });
    const created = await service.createTask({
        task: task(),
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');
    await db.agentReceiverCapabilities.put({
        receiverId: 'battleplan-receiver-a', enabled: true, status: 'ready', persistenceStatus: 'granted', updatedAt: now,
    });
    const ledger = new AgentProtocolLedger(db, () => now);
    const claimed = await ledger.claimCommand({
        commandId: '018f6f5e-2d88-7f2a-8f90-d6ad23001011',
        payloadDigest: `sha256:${'b'.repeat(64)}`,
        producerId: 'hermes-agent', targetReceiverId: 'battleplan-receiver-a', localReceiverId: 'battleplan-receiver-a',
        expiresAt: 10_000, leaseOwner: 'tab-a', leaseDurationMs: 5_000,
    });
    assert.equal(claimed.status, 'claimed');
    if (claimed.status !== 'claimed') return;
    const eventsBefore = await db.agentProtocolEvents.count();

    const stale = await service.updateTask({
        publicId: created.task.publicId,
        expectedRevision: `sha256:${'f'.repeat(64)}`,
        changes: { title: 'Must not apply' },
        context: { actor: 'hermes-agent', origin: 'hermes', causeId: CAUSES.hermes },
        command: { ledger, claim: claimed.claim },
    });

    assert.equal(stale.status, 'stale');
    assert.equal((await db.tasks.get(created.task.id!))?.title, 'Atomic task');
    assert.equal(await db.agentProtocolEvents.count(), eventsBefore);
    assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'stale');
    const result = await db.agentProtocolOutbox.where('commandReceiptId').equals(claimed.claim.receiptId).first();
    assert.deepEqual(result?.payload, { command_id: claimed.claim.commandId, state: 'stale', error_code: 'revision_stale' });
});
