/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import Dexie from 'dexie';

import { BattlePlanDB } from '../../db.ts';
import {
    AgentProtocolLedger,
    type ClaimCommandInput,
    type FinalizeCommandInput,
    type PendingOutboxInput,
} from './ledger.ts';

const RECEIVER_ID = 'battleplan-receiver-a';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const REVISION = { revision_id: DIGEST_B, base_revision: null, mutation_id: 'mutation-1' } as const;

function input(overrides: Partial<ClaimCommandInput> = {}): ClaimCommandInput {
    return {
        commandId: 'command-1',
        payloadDigest: DIGEST_A,
        producerId: 'hermes-agent',
        targetReceiverId: RECEIVER_ID,
        localReceiverId: RECEIVER_ID,
        expiresAt: 10_000,
        leaseOwner: 'tab-a',
        leaseDurationMs: 500,
        ...overrides,
    };
}

interface MutableClock { now: number }

function ledgerFor(db: BattlePlanDB, clock: MutableClock): AgentProtocolLedger {
    return new AgentProtocolLedger(db, () => clock.now);
}

function appliedResultOutbox(id = 'result-command-1'): PendingOutboxInput {
    return {
        id,
        family: 'result',
        messageId: id,
        payload: {
            command_id: 'command-1',
            state: 'applied',
            entity_public_id: 'task_public_1',
            revision: REVISION,
        },
    };
}

async function ready(db: BattlePlanDB): Promise<void> {
    await db.agentReceiverCapabilities.put({
        receiverId: RECEIVER_ID,
        enabled: true,
        status: 'ready',
        persistenceStatus: 'granted',
        updatedAt: 1,
    });
}

test('ten concurrent claims across independent Dexie connections yield one fenced owner and one receipt', async () => {
    const databaseName = `BattlePlan-ledger-concurrency-${Date.now()}-${Math.random()}`;
    const setup = new BattlePlanDB(databaseName);
    await setup.open();
    await ready(setup);
    setup.close();

    const connections = Array.from({ length: 10 }, () => new BattlePlanDB(databaseName));
    const clock = { now: 1_000 };
    try {
        await Promise.all(connections.map((connection) => connection.open()));
        const results = await Promise.all(connections.map((connection, index) => (
            ledgerFor(connection, clock).claimCommand(input({ leaseOwner: `tab-${index}` }))
        )));

        assert.equal(results.filter((result) => result.status === 'claimed').length, 1);
        assert.equal(results.filter((result) => result.status === 'replay').length, 9);
        assert.equal(await connections[0]!.agentCommandReceipts.count(), 1);
        const receipt = await connections[0]!.agentCommandReceipts.toCollection().first();
        assert.equal(receipt?.fencingToken, 1);
        assert.equal(receipt?.attempts, 1);
        assert.equal(receipt?.lifecycle, 'executing');
    } finally {
        connections.forEach((connection) => connection.close());
        await Dexie.delete(databaseName);
    }
});

test('identical replay returns the durable lifecycle while a different digest records conflict without changing the receipt', async () => {
    const databaseName = `BattlePlan-ledger-replay-${Date.now()}-${Math.random()}`;
    const db = new BattlePlanDB(databaseName);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const first = await ledger.claimCommand(input());
        assert.equal(first.status, 'claimed');
        if (first.status !== 'claimed') return;
        clock.now = 1_100;
        const finalized = await ledger.finalizeCommand({
            claim: first.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revisionId: DIGEST_B },
            outbox: [appliedResultOutbox()],
        });
        assert.equal(finalized.status, 'finalized');
        assert.deepEqual(
            (await db.agentCommandReceiptHistory.orderBy('entryIndex').toArray()).map((entry) => entry.lifecycle),
            ['executing', 'applied'],
        );

        const beforeConflict = structuredClone(await db.agentCommandReceipts.get(first.claim.receiptId));
        db.close();
        const reopened = new BattlePlanDB(databaseName);
        await reopened.open();
        clock.now = 2_000;
        const reloadedLedger = ledgerFor(reopened, clock);
        await reopened.agentReceiverCapabilities.update(RECEIVER_ID, { enabled: false, status: 'disabled' });
        const replay = await reloadedLedger.claimCommand(input({
            leaseOwner: 'tab-reload',
            expiresAt: 1_500,
        }));
        assert.equal(replay.status, 'replay');
        assert.equal(replay.receipt.lifecycle, 'applied');

        clock.now = 2_100;
        const conflict = await reloadedLedger.claimCommand(input({ payloadDigest: DIGEST_B, expiresAt: 1_500 }));
        assert.equal(conflict.status, 'conflict');
        assert.equal(conflict.errorCode, 'idempotency_conflict');
        assert.deepEqual(await reopened.agentCommandReceipts.get(first.claim.receiptId), beforeConflict);
        assert.equal(await reopened.agentCommandConflicts.count(), 1);
        assert.equal(await reopened.agentProtocolOutbox.count(), 2);
        const conflictOutbox = (await reopened.agentProtocolOutbox.toArray()).find(
            (row) => row.family === 'result' && row.payload.state === 'rejected',
        );
        assert.equal(conflictOutbox?.family, 'result');
        if (conflictOutbox?.family === 'result') assert.equal(conflictOutbox.payload.state, 'rejected');
        assert.equal((await reloadedLedger.claimCommand(input({
            payloadDigest: DIGEST_B,
            expiresAt: 1_500,
        }))).status, 'conflict');
        assert.equal(await reopened.agentProtocolOutbox.count(), 2);
        reopened.close();
    } finally {
        await db.delete();
    }
});

test('expired lease is reclaimed with a higher fence and stale worker cannot finalize or enqueue publication', async () => {
    const databaseName = `BattlePlan-ledger-fence-${Date.now()}-${Math.random()}`;
    const firstDb = new BattlePlanDB(databaseName);
    const secondDb = new BattlePlanDB(databaseName);
    await firstDb.open();
    await secondDb.open();
    await ready(firstDb);
    const clock = { now: 1_000 };
    try {
        const firstLedger = ledgerFor(firstDb, clock);
        const secondLedger = ledgerFor(secondDb, clock);
        const first = await firstLedger.claimCommand(input({ leaseDurationMs: 100 }));
        assert.equal(first.status, 'claimed');
        if (first.status !== 'claimed') return;
        clock.now = 1_101;
        const expiredOwner = await firstLedger.finalizeCommand({
            claim: first.claim,
            lifecycle: 'applied',
            outbox: [appliedResultOutbox('result-expired-owner')],
        });
        assert.equal(expiredOwner.status, 'fence_lost');
        const second = await secondLedger.claimCommand(input({
            leaseOwner: 'tab-successor', leaseDurationMs: 100,
        }));
        assert.equal(second.status, 'claimed');
        if (second.status !== 'claimed') return;
        assert.equal(second.claim.fencingToken, first.claim.fencingToken + 1);

        clock.now = 1_102;
        const stale = await firstLedger.finalizeCommand({
            claim: first.claim,
            lifecycle: 'applied',
            outbox: [{
                id: 'result-command-1-stale', family: 'result', messageId: 'result-command-1',
                payload: { command_id: 'command-1', state: 'applied', entity_public_id: 'task_public_1', revision: REVISION },
            }],
        });
        assert.equal(stale.status, 'fence_lost');
        assert.equal(await firstDb.agentProtocolOutbox.count(), 0);

        clock.now = 1_103;
        const current = await secondLedger.finalizeCommand({
            claim: second.claim,
            lifecycle: 'applied',
            outbox: [{
                id: 'result-command-1-current', family: 'result', messageId: 'result-command-1',
                payload: { command_id: 'command-1', state: 'applied', entity_public_id: 'task_public_1', revision: REVISION },
            }],
            events: [{
                eventId: 'event-command-1', streamId: 'battleplan-events', producerId: 'battleplan-producer',
                eventType: 'entity_created', entityKind: 'task', entityPublicId: 'task_public_1',
                revision: REVISION, payloadDigest: DIGEST_A, occurredAt: '2026-08-10T12:00:00Z',
                actor: 'battleplan-user', origin: 'ui', causeId: 'mutation-1',
                projection: { title: 'Safe title' },
            }],
        });
        assert.equal(current.status, 'finalized');
        assert.equal(await firstDb.agentProtocolOutbox.count(), 1);
        assert.equal((await firstDb.agentProtocolEvents.toCollection().first())?.sequence, '1');
        firstDb.close();
        secondDb.close();
        const reopened = new BattlePlanDB(databaseName);
        await reopened.open();
        const persistedEvent = await reopened.agentProtocolEvents.toCollection().first();
        assert.deepEqual(persistedEvent?.revision, REVISION);
        assert.equal(persistedEvent?.occurredAt, '2026-08-10T12:00:00Z');
        assert.equal(persistedEvent?.actor, 'battleplan-user');
        assert.equal(persistedEvent?.causeId, 'mutation-1');
        const persistedOutbox = await reopened.agentProtocolOutbox.toCollection().first();
        assert.equal(persistedOutbox?.family, 'result');
        if (persistedOutbox?.family === 'result') assert.equal(persistedOutbox.payload.state, 'applied');
        reopened.close();
    } finally {
        firstDb.close();
        secondDb.close();
        await Dexie.delete(databaseName);
    }
});

test('claim snapshots caller-owned input before the asynchronous transaction boundary', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-input-snapshot-${Date.now()}-${Math.random()}`);
    await db.open();
    await ready(db);
    await db.agentReceiverCapabilities.put({
        receiverId: 'battleplan-receiver-attacker', enabled: true, status: 'ready',
        persistenceStatus: 'granted', updatedAt: 1,
    });
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const callerOwned = input();
        const pendingClaim = ledger.claimCommand(callerOwned);
        callerOwned.localReceiverId = 'battleplan-receiver-attacker';
        callerOwned.targetReceiverId = 'battleplan-receiver-attacker';
        callerOwned.commandId = 'attacker-command';
        const result = await pendingClaim;
        assert.equal(result.status, 'claimed');
        if (result.status === 'claimed') {
            assert.equal(result.claim.receiverId, RECEIVER_ID);
            assert.equal(result.claim.commandId, 'command-1');
        }
        assert.equal(await db.agentCommandReceipts.where('receiverId').equals('battleplan-receiver-attacker').count(), 0);
    } finally {
        await db.delete();
    }
});

test('trusted clock and lifecycle validation fail closed before mutation', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-clock-${Date.now()}-${Math.random()}`);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const claimed = await ledger.claimCommand(input());
        assert.equal(claimed.status, 'claimed');
        if (claimed.status !== 'claimed') return;

        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'blocked',
            errorCode: 'revision_stale',
        } as unknown as FinalizeCommandInput), /Invalid command lifecycle transition/);
        assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'executing');

        clock.now = Number.NaN;
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            outbox: [appliedResultOutbox('result-invalid-clock')],
        }), /finite timestamp/);
        assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'executing');
    } finally {
        await db.delete();
    }
});

test('an injected crash rolls domain state, receipt transition, and outbox back together', async () => {
    const databaseName = `BattlePlan-ledger-rollback-${Date.now()}-${Math.random()}`;
    const db = new BattlePlanDB(databaseName);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const claimed = await ledger.claimCommand(input());
        assert.equal(claimed.status, 'claimed');
        if (claimed.status !== 'claimed') return;
        clock.now = 1_100;

        await assert.rejects(
            ledger.commitFencedMutation(
                {
                    claim: claimed.claim,
                    lifecycle: 'applied',
                    outbox: [{
                        id: 'result-command-crash', family: 'result', messageId: 'result-command-crash',
                        payload: { command_id: 'command-1', state: 'applied', entity_public_id: 'task_public_1', revision: REVISION },
                    }],
                },
                [db.tasks],
                async () => {
                    await db.tasks.add({
                        title: 'must roll back', type: 'task', urgency: 2, status: 'pending',
                        createdAt: 1_100, updatedAt: 1_100,
                    });
                    throw new Error('injected_crash');
                },
            ),
            /injected_crash/,
        );
        assert.equal(await db.tasks.count(), 0);
        assert.equal(await db.agentProtocolOutbox.count(), 0);
        assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'executing');
    } finally {
        await db.delete();
    }
});

test('retry lifecycle is replayed before retryAt and reclaimed afterward under a new fence', async () => {
    const databaseName = `BattlePlan-ledger-retry-${Date.now()}-${Math.random()}`;
    const db = new BattlePlanDB(databaseName);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const first = await ledger.claimCommand(input());
        assert.equal(first.status, 'claimed');
        if (first.status !== 'claimed') return;
        clock.now = 1_100;
        assert.equal((await ledger.finalizeCommand({
            claim: first.claim,
            lifecycle: 'retry_scheduled',
            retryAt: 2_000,
            errorCode: 'transport_retryable',
            outbox: [{
                id: 'result-command-retry', family: 'result', messageId: 'result-command-retry',
                payload: {
                    command_id: 'command-1', state: 'retry_scheduled',
                    error_code: 'transport_retryable', retry_at: '1970-01-01T00:00:02Z',
                },
            }],
        })).status, 'finalized');

        clock.now = 1_999;
        assert.equal((await ledger.claimCommand(input({ leaseOwner: 'early' }))).status, 'replay');
        clock.now = 2_000;
        const retried = await ledger.claimCommand(input({ leaseOwner: 'retry-owner' }));
        assert.equal(retried.status, 'claimed');
        if (retried.status === 'claimed') assert.equal(retried.claim.fencingToken, first.claim.fencingToken + 1);
    } finally {
        await db.delete();
    }
});

test('an unowned receipt becomes terminal when its command expires or receiver is disabled', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-terminal-recovery-${Date.now()}-${Math.random()}`);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const expiring = await ledger.claimCommand(input({ expiresAt: 1_050, leaseDurationMs: 100 }));
        assert.equal(expiring.status, 'claimed');
        clock.now = 1_101;
        const expired = await ledger.claimCommand(input({
            expiresAt: 1_050,
            leaseOwner: 'recovery-owner',
            leaseDurationMs: 100,
        }));
        assert.equal(expired.status, 'replay');
        if (expired.status === 'replay') assert.equal(expired.receipt.lifecycle, 'expired');

        clock.now = 2_000;
        await db.agentReceiverCapabilities.update(RECEIVER_ID, { enabled: true, status: 'ready' });
        const disabling = await ledger.claimCommand(input({
            commandId: 'command-disabled',
            leaseDurationMs: 100,
        }));
        assert.equal(disabling.status, 'claimed');
        clock.now = 2_101;
        await db.agentReceiverCapabilities.update(RECEIVER_ID, { enabled: false, status: 'disabled' });
        const blocked = await ledger.claimCommand(input({
            commandId: 'command-disabled',
            leaseOwner: 'recovery-owner',
            leaseDurationMs: 100,
        }));
        assert.equal(blocked.status, 'replay');
        if (blocked.status === 'replay') assert.equal(blocked.receipt.lifecycle, 'blocked');
        assert.equal(await db.agentProtocolOutbox.count(), 2);
    } finally {
        await db.delete();
    }
});

test('wrong receiver, expiry, and disabled capability stay quarantined before receipt creation', async () => {
    const databaseName = `BattlePlan-ledger-preconditions-${Date.now()}-${Math.random()}`;
    const db = new BattlePlanDB(databaseName);
    await db.open();
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        await ready(db);
        const wrong = await ledger.claimCommand(input({ targetReceiverId: 'other-receiver' }));
        assert.deepEqual(wrong, { status: 'quarantined', reason: 'target_mismatch' });
        const expired = await ledger.claimCommand(input({ expiresAt: 999 }));
        assert.deepEqual(expired, { status: 'quarantined', reason: 'message_expired' });
        await db.agentReceiverCapabilities.update(RECEIVER_ID, { enabled: false, status: 'disabled' });
        const disabled = await ledger.claimCommand(input());
        assert.deepEqual(disabled, { status: 'quarantined', reason: 'receiver_disabled' });
        const malformed = await ledger.claimCommand(input({ payloadDigest: 'sha256:not-a-digest' as typeof DIGEST_A }));
        assert.deepEqual(malformed, { status: 'quarantined', reason: 'schema_invalid' });
        assert.equal(await db.agentCommandReceipts.count(), 0);
    } finally {
        await db.delete();
    }
});

test('event sequences are monotonic across independent database connections', async () => {
    const databaseName = `BattlePlan-ledger-events-${Date.now()}-${Math.random()}`;
    const connections = Array.from({ length: 10 }, () => new BattlePlanDB(databaseName));
    try {
        await Promise.all(connections.map((connection) => connection.open()));
        const sequences = await Promise.all(connections.map((connection, index) => (
            ledgerFor(connection, { now: index }).reserveEventSequence('battleplan-events', 'battleplan-producer')
        )));
        assert.deepEqual(sequences.map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
            Array.from({ length: 10 }, (_, index) => BigInt(index + 1)));
        assert.equal((await connections[0]!.agentEventStreams.get('battleplan-events'))?.nextSequence, '11');
    } finally {
        connections.forEach((connection) => connection.close());
        await Dexie.delete(databaseName);
    }
});

test('consumer sequence state stops on a gap and preserves the durable expected sequence', async () => {
    const databaseName = `BattlePlan-ledger-gap-${Date.now()}-${Math.random()}`;
    const db = new BattlePlanDB(databaseName);
    await db.open();
    const clock = { now: 1 };
    const ledger = ledgerFor(db, clock);
    try {
        assert.equal((await ledger.ingestConsumerSequence({
            consumerId: 'hermes', streamId: 'battleplan-events', sequence: '1',
        })).status, 'advanced');
        clock.now = 2;
        const gap = await ledger.ingestConsumerSequence({
            consumerId: 'hermes', streamId: 'battleplan-events', sequence: '3',
        });
        assert.deepEqual(gap, { status: 'gap', expected: '2', observed: '3' });
        const state = await db.agentConsumerStates.get('hermes\0battleplan-events');
        assert.equal(state?.lastSequence, '1');
        assert.equal(state?.gapExpected, '2');
        assert.equal(state?.gapObserved, '3');
        assert.equal(state?.requiresSnapshot, true);
    } finally {
        await db.delete();
    }
});
