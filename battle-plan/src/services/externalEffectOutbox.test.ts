/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BattlePlanDB, type Task } from '../db.ts';
import { AgentProtocolLedger } from './agentProtocol/ledger.ts';
import { ExternalEffectOutbox } from './externalEffectOutbox.ts';
import { TaskMutationService } from './taskMutations.ts';

const CAUSE_ID = '018f6f5e-2d88-7f2a-8f90-d6ad23001101';

test('Calendar failure keeps one Task and retry executes only the durable effect', async (t) => {
    const db = new BattlePlanDB(`ExternalEffects-${crypto.randomUUID()}`);
    await db.open();
    t.after(async () => db.delete());
    let now = Date.parse('2026-08-11T08:00:00Z');
    const mutations = new TaskMutationService(db, { now: () => now });
    const created = await mutations.createTask({
        task: {
            title: 'Durable meeting', description: 'Keep one row', type: 'meeting', urgency: 2, status: 'pending',
            date: '2026-08-12', startTime: '09:00', duration: 30,
        } satisfies Omit<Task, 'id' | 'publicId' | 'protocolRevision' | 'createdAt' | 'updatedAt'>,
        context: { actor: 'battleplan-user', origin: 'voice', causeId: CAUSE_ID },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    assert.equal(created.status, 'applied');

    let calls = 0;
    const outbox = new ExternalEffectOutbox(db, {
        now: () => now,
        execute: async () => {
            calls += 1;
            if (calls === 1) throw new Error('calendar temporarily unavailable');
            return { externalId: 'calendar-event-1' };
        },
        retryDelayMs: () => 1_000,
    });

    assert.deepEqual(await outbox.drainOnce(), { attempted: 1, succeeded: 0, retryScheduled: 1, failed: 0 });
    assert.equal(await db.tasks.count(), 1);
    assert.equal(await db.agentProtocolEvents.count(), 1);
    assert.equal((await db.agentProtocolEffects.toCollection().first())?.state, 'retry_scheduled');

    now += 1_001;
    assert.deepEqual(await outbox.drainOnce(), { attempted: 1, succeeded: 1, retryScheduled: 0, failed: 0 });
    assert.equal(calls, 2);
    assert.equal(await db.tasks.count(), 1);
    assert.equal(await db.agentProtocolEvents.count(), 1, 'effect retry must not repeat the domain mutation');
    assert.equal((await db.tasks.get(created.task.id!))?.googleEventId, 'calendar-event-1');
    assert.equal((await db.agentProtocolEffects.toCollection().first())?.state, 'succeeded');
});

test('two drainers cannot execute one claimed effect twice', async (t) => {
    const db = new BattlePlanDB(`ExternalEffects-${crypto.randomUUID()}`);
    await db.open();
    t.after(async () => db.delete());
    const mutations = new TaskMutationService(db);
    await mutations.createTask({
        task: { title: 'Meeting', type: 'meeting', urgency: 2, status: 'pending' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSE_ID },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = async () => { calls += 1; await gate; return { externalId: 'event-1' }; };
    const first = new ExternalEffectOutbox(db, { execute });
    const second = new ExternalEffectOutbox(db, { execute });

    const a = first.drainOnce();
    const b = second.drainOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([a, b]);

    assert.equal(calls, 1);
    assert.equal((await db.agentProtocolEffects.toCollection().first())?.state, 'succeeded');
});

test('a new worker reclaims an expired running lease after a crash', async (t) => {
    const db = new BattlePlanDB(`ExternalEffects-${crypto.randomUUID()}`);
    await db.open();
    t.after(async () => db.delete());
    const now = 1_000;
    const mutations = new TaskMutationService(db, { now: () => now });
    await mutations.createTask({
        task: { title: 'Crash recovery', type: 'meeting', urgency: 2, status: 'pending' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSE_ID },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    const effect = await db.agentProtocolEffects.toCollection().first();
    assert.ok(effect);
    await db.agentProtocolEffects.put({
        ...effect,
        state: 'running',
        attempts: 1,
        fencingToken: 1,
        leaseOwner: 'crashed-worker',
        leaseExpiresAt: 900,
    });
    let calls = 0;
    const recovered = new ExternalEffectOutbox(db, {
        now: () => now,
        execute: async () => { calls += 1; return { externalId: 'recovered-event' }; },
    });

    assert.deepEqual(await recovered.drainOnce(), { attempted: 1, succeeded: 1, retryScheduled: 0, failed: 0 });
    assert.equal(calls, 1);
    assert.equal((await db.agentProtocolEffects.get(effect.id))?.fencingToken, 2);
});

test('terminal command effect failure durably updates the receipt and publishes an applied result transition', async (t) => {
    const db = new BattlePlanDB(`ExternalEffects-${crypto.randomUUID()}`);
    await db.open();
    t.after(async () => db.delete());
    const now = 1_000;
    await db.agentReceiverCapabilities.put({
        receiverId: 'battleplan-receiver-a', enabled: true, status: 'ready', persistenceStatus: 'granted', updatedAt: now,
    });
    const ledger = new AgentProtocolLedger(db, () => now);
    const claim = await ledger.claimCommand({
        commandId: '018f6f5e-2d88-7f2a-8f90-d6ad23001110',
        payloadDigest: `sha256:${'c'.repeat(64)}`,
        producerId: 'hermes-agent', targetReceiverId: 'battleplan-receiver-a', localReceiverId: 'battleplan-receiver-a',
        expiresAt: 10_000, leaseOwner: 'tab-a', leaseDurationMs: 5_000,
    });
    assert.equal(claim.status, 'claimed');
    if (claim.status !== 'claimed') return;
    const mutations = new TaskMutationService(db, { now: () => now });
    const mutation = await mutations.createTask({
        task: { title: 'Command meeting', type: 'meeting', urgency: 2, status: 'pending' },
        context: { actor: 'hermes-agent', origin: 'hermes', causeId: CAUSE_ID },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
        command: { ledger, claim: claim.claim },
    });
    assert.equal(mutation.status, 'applied');

    const outbox = new ExternalEffectOutbox(db, { execute: async () => { throw new Error('terminal'); }, maxAttempts: 1 });
    assert.deepEqual(await outbox.drainOnce(), { attempted: 1, succeeded: 0, retryScheduled: 0, failed: 1 });

    assert.equal((await db.agentCommandReceipts.get(claim.claim.receiptId))?.effectState, 'failed');
    const results = (await db.agentProtocolOutbox.where('commandReceiptId').equals(claim.claim.receiptId).toArray())
        .filter((row) => row.family === 'result');
    assert.equal(results.length, 2);
    assert.ok(results.some((row) => row.family === 'result'
        && row.payload.state === 'applied'
        && row.payload.effects?.some((effect) => effect.state === 'failed' && effect.error_code === 'external_effect_failed')));
    assert.equal(await db.tasks.count(), 1);
    assert.equal(await db.agentProtocolEvents.count(), 1);
});
