/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import Dexie from 'dexie';

import { BattlePlanDB, type AgentCommandReceiptRow } from '../../db.ts';
import {
    calculateEd25519PublicKeyFingerprint,
    calculateProtocolRevisionId,
    createDetachedSignature,
    verifySnapshotForInstall,
    type VerifySnapshotForInstallOptions,
    type VerifiedSnapshotProof,
} from './validation.ts';
import type { ProtocolSignedMessage, ProtocolWireMessage } from './contracts.ts';
import {
    AgentProtocolLedger,
    CONSUMER_INACTIVITY_MS,
    type ClaimCommandInput,
    type FinalizeCommandInput,
    type PendingOutboxInput,
} from './ledger.ts';

const RECEIVER_ID = 'battleplan-receiver-a';
const COMMAND_ID = '018f6f5e-2d88-7f2a-8f90-d6ad23000401';
const SECOND_COMMAND_ID = '018f6f5e-2d88-7f2a-8f90-d6ad23000409';
const DISABLED_COMMAND_ID = '018f6f5e-2d88-7f2a-8f90-d6ad23000403';
const FRESH_DISABLED_COMMAND_ID = '018f6f5e-2d88-7f2a-8f90-d6ad23000404';
const EVENT_ID = '018f6f5e-2d88-7f2a-8f90-d6ad23000405';
const CAUSE_ID = '018f6f5e-2d88-7f2a-8f90-d6ad23000406';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const REVISION = {
    revision_id: DIGEST_B,
    base_revision: null,
    mutation_id: '018f6f5e-2d88-7f2a-8f90-d6ad23000402',
} as const;

function input(overrides: Partial<ClaimCommandInput> = {}): ClaimCommandInput {
    return {
        commandId: COMMAND_ID,
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
        messageId: crypto.randomUUID(),
        payload: {
            command_id: COMMAND_ID,
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

async function verifiedSnapshotProof(
    highWaterMark = '10',
    mutateOptionsDuringVerification = false,
): Promise<VerifiedSnapshotProof> {
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const projection = { title: 'Snapshot task', status: 'pending' };
    const revision = {
        revision_id: calculateProtocolRevisionId({
            entity_kind: 'task',
            entity_public_id: 'task_snapshot_1',
            base_revision: null,
            mutation_id: CAUSE_ID,
            projection,
            tombstone: false,
        }),
        base_revision: null,
        mutation_id: CAUSE_ID,
    } as const;
    const signed: Extract<ProtocolSignedMessage, { message_type: 'snapshot' }> = {
        protocol_version: '2.0.0',
        message_type: 'snapshot',
        message_id: '018f6f5e-2d88-7f2a-8f90-d6ad23000407',
        workspace_id: '018f6f5e-2d88-7f2a-8f90-d6ad23000408',
        producer_id: 'hermes-agent',
        target: { kind: 'stream', id: 'battleplan-events' },
        created_at: '2026-08-10T12:00:00Z',
        correlation_id: null,
        causation_id: null,
        signing_key_id: 'ed25519:hermes-test',
        pairing_epoch: 1,
        payload: {
            stream_id: 'battleplan-events',
            high_water_mark: highWaterMark,
            generated_at: '2026-08-10T12:00:00Z',
            entities: [{
                state: 'resolved',
                entity_kind: 'task',
                entity_public_id: 'task_snapshot_1',
                revision,
                projection,
                tombstone: false,
            }],
        },
    };
    const message: ProtocolWireMessage = {
        signed,
        signature: await createDetachedSignature(signed, keys.privateKey),
    };
    const options: VerifySnapshotForInstallOptions = {
        pairingRecordId: 'snapshot-pairing-hermes',
        receiverId: 'hermes',
        trustedPairing: {
            status: 'active',
            workspaceId: signed.workspace_id,
            producerId: signed.producer_id,
            targetId: signed.target.id,
            keyId: signed.signing_key_id,
            pairingEpoch: signed.pairing_epoch,
            rawPublicKey: Buffer.from(rawPublicKey).toString('base64url'),
            fingerprint: calculateEd25519PublicKeyFingerprint(rawPublicKey),
        },
        trustedContractArtifact: {
            id: 'battleplan-hermes-protocol',
            version: '2.0.0',
            sha256: DIGEST_A,
        },
    };
    const pendingVerification = verifySnapshotForInstall(message, options);
    if (mutateOptionsDuringVerification) {
        const substitutedKey = new Uint8Array(32).fill(7);
        signed.target.id = 'attacker-stream';
        signed.payload.stream_id = 'attacker-stream';
        options.pairingRecordId = 'snapshot-pairing-attacker';
        options.receiverId = 'attacker';
        options.trustedPairing.targetId = 'attacker-stream';
        options.trustedPairing.rawPublicKey = Buffer.from(substitutedKey).toString('base64url');
        options.trustedPairing.fingerprint = calculateEd25519PublicKeyFingerprint(substitutedKey);
        options.trustedContractArtifact.sha256 = DIGEST_B;
    }
    const verification = await pendingVerification;
    if (!verification.ok) assert.fail(`${verification.error.code}: ${verification.error.message}`);
    return verification.proof;
}

test('snapshot proof keeps caller-owned wire and trust inputs immutable across WebCrypto awaits', async () => {
    const proof = await verifiedSnapshotProof('10', true);
    assert.equal(proof.pairingRecordId, 'snapshot-pairing-hermes');
    assert.equal(proof.receiverId, 'hermes');
    assert.equal(proof.targetStreamId, 'battleplan-events');
    assert.equal(proof.contractArtifact.sha256, DIGEST_A);
    assert.notEqual(proof.keyFingerprint, calculateEd25519PublicKeyFingerprint(new Uint8Array(32).fill(7)));
});

async function activateSnapshotPairing(
    db: BattlePlanDB,
    proof: VerifiedSnapshotProof,
): Promise<void> {
    await db.agentPairingKeys.put({
        id: proof.pairingRecordId,
        workspaceId: proof.workspaceId,
        producerId: proof.producerId,
        receiverId: proof.receiverId,
        keyId: proof.signingKeyId,
        pairingEpoch: proof.pairingEpoch,
        publicKey: proof.rawPublicKey,
        fingerprint: proof.keyFingerprint,
        protocolVersion: proof.protocolVersion,
        contractArtifact: proof.contractArtifact,
        status: 'active',
        createdAt: 1,
        retainUntil: Number.MAX_SAFE_INTEGER,
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
            result: { entityPublicId: 'task_public_1', revision: REVISION },
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
            result: { entityPublicId: 'task_public_1', revision: REVISION },
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
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [{
                id: 'result-command-1-stale', family: 'result', messageId: crypto.randomUUID(),
                payload: { command_id: COMMAND_ID, state: 'applied', entity_public_id: 'task_public_1', revision: REVISION },
            }],
        });
        assert.equal(stale.status, 'fence_lost');
        assert.equal(await firstDb.agentProtocolOutbox.count(), 0);

        clock.now = 1_103;
        const current = await secondLedger.finalizeCommand({
            claim: second.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [{
                id: 'result-command-1-current', family: 'result', messageId: crypto.randomUUID(),
                payload: { command_id: COMMAND_ID, state: 'applied', entity_public_id: 'task_public_1', revision: REVISION },
            }],
            events: [{
                eventId: EVENT_ID, streamId: 'battleplan-events', producerId: 'battleplan-producer',
                eventType: 'entity_created', entityKind: 'task', entityPublicId: 'task_public_1',
                revision: REVISION, payloadDigest: DIGEST_A, occurredAt: '2026-08-10T12:00:00Z',
                actor: 'battleplan-user', origin: 'ui', causeId: CAUSE_ID,
                projection: { title: 'Safe title' },
            }],
        });
        assert.equal(current.status, 'finalized');
        assert.equal(await firstDb.agentProtocolOutbox.count(), 2);
        const eventOutbox = (await firstDb.agentProtocolOutbox.toArray()).find((row) => row.family === 'event');
        assert.equal(eventOutbox?.family, 'event');
        if (eventOutbox?.family === 'event') {
            assert.equal(eventOutbox.payload.sequence_from, '1');
            assert.equal(eventOutbox.payload.sequence_to, '1');
            assert.equal(eventOutbox.payload.events[0]?.event_id, EVENT_ID);
        }
        assert.equal((await firstDb.agentProtocolEvents.toCollection().first())?.sequence, '1');
        firstDb.close();
        secondDb.close();
        const reopened = new BattlePlanDB(databaseName);
        await reopened.open();
        const persistedEvent = await reopened.agentProtocolEvents.toCollection().first();
        assert.deepEqual(persistedEvent?.revision, REVISION);
        assert.equal(persistedEvent?.occurredAt, '2026-08-10T12:00:00Z');
        assert.equal(persistedEvent?.actor, 'battleplan-user');
        assert.equal(persistedEvent?.causeId, CAUSE_ID);
        const persistedOutbox = (await reopened.agentProtocolOutbox.toArray()).find((row) => row.family === 'result');
        assert.equal(persistedOutbox?.family, 'result');
        if (persistedOutbox?.family === 'result') assert.equal(persistedOutbox.payload.state, 'applied');
        reopened.close();
    } finally {
        firstDb.close();
        secondDb.close();
        await Dexie.delete(databaseName);
    }
});

test('a receipt cannot finalize a result for a different command identity', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-command-binding-${Date.now()}-${Math.random()}`);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const claimed = await ledger.claimCommand(input());
        assert.equal(claimed.status, 'claimed');
        if (claimed.status !== 'claimed') return;

        let mutationRan = false;
        const result = await ledger.commitFencedMutation({
            claim: { ...claimed.claim, commandId: SECOND_COMMAND_ID },
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [{
                id: 'cross-command-result',
                family: 'result',
                messageId: crypto.randomUUID(),
                payload: {
                    command_id: SECOND_COMMAND_ID,
                    state: 'applied',
                    entity_public_id: 'task_public_1',
                    revision: REVISION,
                },
            }],
        }, [db.tasks], async () => {
            mutationRan = true;
            return db.tasks.add({
                publicId: 'task_cross_command', title: 'Must not be written', type: 'task',
                urgency: 2, status: 'pending', createdAt: clock.now, updatedAt: clock.now,
            });
        });
        assert.equal(result.status, 'fence_lost');
        assert.equal(mutationRan, false);
        assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'executing');
        assert.equal(await db.agentCommandReceiptHistory.count(), 1);
        assert.equal(await db.agentProtocolOutbox.count(), 0);
        assert.equal(await db.agentProtocolEffects.count(), 0);
        assert.equal(await db.agentProtocolEvents.count(), 0);
        assert.equal(await db.tasks.count(), 0);
    } finally {
        await db.delete();
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
            assert.equal(result.claim.commandId, COMMAND_ID);
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
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [appliedResultOutbox('result-invalid-clock')],
        }), /finite timestamp/);
        assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'executing');

        clock.now = 1_100;
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [{
                id: 'incomplete-result', family: 'result', messageId: crypto.randomUUID(),
                payload: { command_id: COMMAND_ID, state: 'applied' } as never,
            }],
        }), /Invalid command lifecycle transition/);
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [{
                id: 'inconsistent-result', family: 'result', messageId: crypto.randomUUID(),
                payload: {
                    command_id: COMMAND_ID, state: 'applied', entity_public_id: 'task_public_other',
                    revision: REVISION,
                },
            }],
        }), /Invalid command lifecycle transition/);
        for (const payload of [
            {
                command_id: COMMAND_ID,
                state: 'applied',
                entity_public_id: 'INVALID PUBLIC ID',
                revision: REVISION,
            },
            {
                command_id: COMMAND_ID,
                state: 'applied',
                entity_public_id: 'task_public_1',
                revision: { ...REVISION, mutation_id: CAUSE_ID },
            },
            {
                command_id: COMMAND_ID,
                state: 'applied',
                entity_public_id: 'task_public_1',
                revision: REVISION,
                effects: [{ effect_id: 'not-a-uuid', kind: 'drive', state: 'pending' }],
            },
        ]) {
            await assert.rejects(ledger.finalizeCommand({
                claim: claimed.claim,
                lifecycle: 'applied',
                result: { entityPublicId: 'task_public_1', revision: REVISION },
                outbox: [{
                    id: 'adversarial-result', family: 'result', messageId: crypto.randomUUID(), payload,
                } as never],
            }), /Invalid command lifecycle transition/);
        }
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [{ ...appliedResultOutbox('invalid-envelope-id'), messageId: 'not-a-uuid' }],
        }), /Invalid command lifecycle transition/);
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'retry_scheduled',
            errorCode: 'transport_retryable',
            retryAt: 2_000,
            outbox: [{
                id: 'inconsistent-retry', family: 'result', messageId: crypto.randomUUID(),
                payload: {
                    command_id: COMMAND_ID, state: 'retry_scheduled',
                    error_code: 'transport_retryable', retry_at: '1970-01-01T00:00:03Z',
                },
            }],
        }), /Invalid command lifecycle transition/);
        const normalizedImpossibleDate = Date.parse('2026-02-31T00:00:00Z');
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'retry_scheduled',
            errorCode: 'transport_retryable',
            retryAt: normalizedImpossibleDate,
            outbox: [{
                id: 'impossible-retry-date', family: 'result', messageId: crypto.randomUUID(),
                payload: {
                    command_id: COMMAND_ID, state: 'retry_scheduled',
                    error_code: 'transport_retryable', retry_at: '2026-02-31T00:00:00Z',
                },
            }],
        }), /Invalid command lifecycle transition/);
        assert.equal(await db.agentProtocolOutbox.count(), 0);
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
                    result: { entityPublicId: 'task_public_1', revision: REVISION },
                    outbox: [{
                        id: 'result-command-crash', family: 'result', messageId: crypto.randomUUID(),
                        payload: { command_id: COMMAND_ID, state: 'applied', entity_public_id: 'task_public_1', revision: REVISION },
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
                id: 'result-command-retry', family: 'result', messageId: crypto.randomUUID(),
                payload: {
                    command_id: COMMAND_ID, state: 'retry_scheduled',
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
            commandId: DISABLED_COMMAND_ID,
            leaseDurationMs: 100,
        }));
        assert.equal(disabling.status, 'claimed');
        clock.now = 2_101;
        await db.agentReceiverCapabilities.update(RECEIVER_ID, { enabled: false, status: 'disabled' });
        const blocked = await ledger.claimCommand(input({
            commandId: DISABLED_COMMAND_ID,
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

test('command expiry overrides an active lease, replay, and a late domain finalization', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-active-expiry-${Date.now()}-${Math.random()}`);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const replayClaim = await ledger.claimCommand(input({ expiresAt: 1_050, leaseDurationMs: 500 }));
        assert.equal(replayClaim.status, 'claimed');
        clock.now = 1_051;
        const replay = await ledger.claimCommand(input({
            expiresAt: 1_050,
            leaseOwner: 'replay-after-expiry',
            leaseDurationMs: 500,
        }));
        assert.equal(replay.status, 'replay');
        if (replay.status === 'replay') assert.equal(replay.receipt.lifecycle, 'expired');
        const repeatedReplay = await ledger.claimCommand(input({
            expiresAt: 1_050,
            leaseOwner: 'second-replay-after-expiry',
            leaseDurationMs: 500,
        }));
        assert.equal(repeatedReplay.status, 'replay');
        if (repeatedReplay.status === 'replay') assert.equal(repeatedReplay.receipt.lifecycle, 'expired');

        clock.now = 2_000;
        const lateClaim = await ledger.claimCommand(input({
            commandId: SECOND_COMMAND_ID,
            expiresAt: 2_050,
            leaseOwner: 'late-finalizer',
            leaseDurationMs: 500,
        }));
        assert.equal(lateClaim.status, 'claimed');
        if (lateClaim.status !== 'claimed') return;
        clock.now = 2_051;
        const lateFinalize = await ledger.commitFencedMutation(
            {
                claim: lateClaim.claim,
                lifecycle: 'applied',
                result: { entityPublicId: 'task_public_2', revision: REVISION },
                outbox: [{
                    id: 'late-applied-result',
                    family: 'result',
                    messageId: crypto.randomUUID(),
                    payload: {
                        command_id: SECOND_COMMAND_ID,
                        state: 'applied',
                        entity_public_id: 'task_public_2',
                        revision: REVISION,
                    },
                }],
            },
            [db.tasks],
            async () => db.tasks.add({
                publicId: 'task_public_2', title: 'Must not be committed', type: 'task',
                urgency: 2, status: 'pending', createdAt: clock.now, updatedAt: clock.now,
            }),
        );
        assert.equal(lateFinalize.status, 'expired');
        assert.equal((await ledger.finalizeCommand({
            claim: lateClaim.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_2', revision: REVISION },
            outbox: [{
                id: 'repeated-late-applied-result',
                family: 'result',
                messageId: crypto.randomUUID(),
                payload: {
                    command_id: SECOND_COMMAND_ID,
                    state: 'applied',
                    entity_public_id: 'task_public_2',
                    revision: REVISION,
                },
            }],
        })).status, 'fence_lost');
        assert.equal(await db.tasks.count(), 0);
        assert.equal((await db.agentCommandReceipts.get(lateClaim.claim.receiptId))?.lifecycle, 'expired');
        const results = await db.agentProtocolOutbox.where('family').equals('result').toArray();
        assert.equal(results.length, 2);
        assert.ok(results.every((row) => row.family === 'result' && row.payload.state === 'expired'));
        assert.equal(new Set(results.map((row) => row.commandReceiptId)).size, 2);
        assert.equal(await db.agentCommandReceiptHistory.count(), 4);
    } finally {
        await db.delete();
    }
});

test('a legacy receipt without authenticated expiry cannot inherit a later replay expiry', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-legacy-expiry-${Date.now()}-${Math.random()}`);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const first = await ledger.claimCommand(input({ expiresAt: 1_050, leaseDurationMs: 500 }));
        assert.equal(first.status, 'claimed');
        if (first.status !== 'claimed') return;

        const legacyReceipt = await db.agentCommandReceipts.get(first.claim.receiptId);
        assert.ok(legacyReceipt);
        const legacyWithoutExpiry = { ...legacyReceipt } as Partial<AgentCommandReceiptRow>;
        delete legacyWithoutExpiry.commandExpiresAt;
        await db.agentCommandReceipts.put(legacyWithoutExpiry as AgentCommandReceiptRow);

        clock.now = 1_501;
        const replay = await ledger.claimCommand(input({
            expiresAt: 5_000,
            leaseOwner: 'legacy-replay-owner',
            leaseDurationMs: 500,
        }));
        assert.equal(replay.status, 'replay');
        if (replay.status !== 'replay') return;
        assert.equal(replay.receipt.lifecycle, 'expired');
        assert.equal(replay.receipt.commandExpiresAt, 0);

        const repeated = await ledger.claimCommand(input({
            expiresAt: 9_000,
            leaseOwner: 'second-legacy-replay-owner',
            leaseDurationMs: 500,
        }));
        assert.equal(repeated.status, 'replay');
        if (repeated.status === 'replay') assert.equal(repeated.receipt.lifecycle, 'expired');
        assert.equal(await db.agentProtocolOutbox.where('family').equals('result').count(), 1);
        assert.equal(await db.tasks.count(), 0);
    } finally {
        await db.delete();
    }
});

test('authenticated fresh expiry and disabled capability create durable terminal evidence', async () => {
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
        assert.equal(expired.status, 'replay');
        if (expired.status === 'replay') assert.equal(expired.receipt.lifecycle, 'expired');
        await db.agentReceiverCapabilities.update(RECEIVER_ID, { enabled: false, status: 'disabled' });
        const disabled = await ledger.claimCommand(input({ commandId: FRESH_DISABLED_COMMAND_ID }));
        assert.equal(disabled.status, 'replay');
        if (disabled.status === 'replay') assert.equal(disabled.receipt.lifecycle, 'blocked');
        const malformed = await ledger.claimCommand(input({ payloadDigest: 'sha256:not-a-digest' as typeof DIGEST_A }));
        assert.deepEqual(malformed, { status: 'quarantined', reason: 'schema_invalid' });
        assert.equal(await db.agentCommandReceipts.count(), 2);
        assert.equal(await db.agentCommandReceiptHistory.count(), 2);
        assert.equal(await db.agentProtocolOutbox.count(), 2);
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

test('inactive consumer requires a verified snapshot before accepting the next incremental event', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-inactive-${Date.now()}-${Math.random()}`);
    await db.open();
    const clock = { now: 1 };
    const ledger = ledgerFor(db, clock);
    try {
        assert.equal((await ledger.ingestConsumerSequence({
            consumerId: 'hermes', streamId: 'battleplan-events', sequence: '1',
        })).status, 'advanced');
        clock.now = 1 + CONSUMER_INACTIVITY_MS;
        const inactive = await ledger.ingestConsumerSequence({
            consumerId: 'hermes', streamId: 'battleplan-events', sequence: '2',
        });
        assert.deepEqual(inactive, { status: 'gap', expected: '2', observed: '2' });

        await assert.rejects(ledger.installVerifiedConsumerSnapshot({
            consumerId: 'hermes',
            proof: { targetStreamId: 'battleplan-events', payload: { high_water_mark: '10', entities: [] } } as never,
            domainTables: [],
            installProjection: async () => ({ value: undefined, installedEntityCount: 0 }),
        }), /capability was not satisfied/);
        assert.equal((await db.agentConsumerStates.get('hermes\0battleplan-events'))?.requiresSnapshot, true);

        const proof = await verifiedSnapshotProof();
        await activateSnapshotPairing(db, proof);
        await assert.rejects(ledger.installVerifiedConsumerSnapshot({
            consumerId: 'other-consumer',
            proof,
            domainTables: [db.tasks],
            installProjection: async (payload) => ({ value: undefined, installedEntityCount: payload.entities.length }),
        }), /capability was not satisfied/);
        assert.equal(await db.tasks.count(), 0);

        await db.agentPairingKeys.update(proof.pairingRecordId, { fingerprint: DIGEST_A });
        await assert.rejects(ledger.installVerifiedConsumerSnapshot({
            consumerId: 'hermes',
            proof,
            domainTables: [db.tasks],
            installProjection: async (payload) => ({ value: undefined, installedEntityCount: payload.entities.length }),
        }), /active durable pairing/);
        assert.equal(await db.tasks.count(), 0);
        await activateSnapshotPairing(db, proof);

        await assert.rejects(ledger.installVerifiedConsumerSnapshot({
            consumerId: 'hermes',
            proof,
            domainTables: [db.tasks],
            installProjection: async (payload) => {
                await db.agentPairingKeys.update(proof.pairingRecordId, { status: 'revoked' });
                return { value: undefined, installedEntityCount: payload.entities.length };
            },
        }), /changed during installation/);
        assert.equal((await db.agentPairingKeys.get(proof.pairingRecordId))?.status, 'active');
        assert.equal((await db.agentConsumerStates.get('hermes\0battleplan-events'))?.requiresSnapshot, true);

        await assert.rejects(ledger.installVerifiedConsumerSnapshot({
            consumerId: 'hermes',
            proof,
            domainTables: [db.tasks],
            installProjection: async (payload) => {
                const entity = payload.entities[0]!;
                if (entity.state !== 'resolved') throw new Error('expected resolved snapshot entity');
                await db.tasks.put({
                    publicId: entity.entity_public_id,
                    title: String(entity.projection.title),
                    type: 'task', urgency: 2, status: 'pending', updatedAt: 1, createdAt: 1,
                });
                throw new Error('simulated snapshot install crash');
            },
        }), /simulated snapshot install crash/);
        assert.equal(await db.tasks.where('publicId').equals('task_snapshot_1').count(), 0);
        assert.equal((await db.agentConsumerStates.get('hermes\0battleplan-events'))?.requiresSnapshot, true);

        const installed = await ledger.installVerifiedConsumerSnapshot({
            consumerId: 'hermes',
            proof,
            domainTables: [db.tasks],
            installProjection: async (payload) => {
                const entity = payload.entities[0]!;
                if (entity.state !== 'resolved') throw new Error('expected resolved snapshot entity');
                await db.tasks.put({
                    publicId: entity.entity_public_id,
                    title: String(entity.projection.title),
                    type: 'task', urgency: 2, status: 'pending', updatedAt: 1, createdAt: 1,
                });
                return { value: 'installed', installedEntityCount: payload.entities.length };
            },
        });
        assert.equal(installed.value, 'installed');
        const recovered = await db.agentConsumerStates.get('hermes\0battleplan-events');
        assert.equal(recovered?.lastSequence, '10');
        assert.equal(recovered?.requiresSnapshot, false);
        assert.equal(recovered?.lastSnapshotMessageId, proof.messageId);
        assert.equal(recovered?.lastSnapshotContentSha256, proof.contentSha256);
        assert.equal(recovered?.lastSnapshotPairingRecordId, proof.pairingRecordId);
        assert.equal(recovered?.lastSnapshotContractArtifactSha256, proof.contractArtifact.sha256);
        assert.equal(recovered?.gapExpected, undefined);
        assert.equal(recovered?.gapObserved, undefined);
        assert.equal((await db.tasks.where('publicId').equals('task_snapshot_1').first())?.title, 'Snapshot task');

        const backwardProof = await verifiedSnapshotProof('9');
        await activateSnapshotPairing(db, backwardProof);
        await assert.rejects(ledger.installVerifiedConsumerSnapshot({
            consumerId: 'hermes',
            proof: backwardProof,
            domainTables: [db.tasks],
            installProjection: async (payload) => ({ value: undefined, installedEntityCount: payload.entities.length }),
        }), /cannot move backward/);

        clock.now += 1;
        assert.equal((await ledger.ingestConsumerSequence({
            consumerId: 'hermes', streamId: 'battleplan-events', sequence: '11',
        })).status, 'advanced');
        const advanced = await db.agentConsumerStates.get('hermes\0battleplan-events');
        assert.equal(advanced?.lastSnapshotMessageId, proof.messageId);
        assert.equal(advanced?.lastSnapshotContentSha256, proof.contentSha256);
        assert.equal(advanced?.lastSnapshotPairingRecordId, proof.pairingRecordId);
        assert.equal(advanced?.lastSnapshotContractArtifactSha256, proof.contractArtifact.sha256);
    } finally {
        await db.delete();
    }
});

test('event commits generate their matching outbox and reject caller-supplied event publication', async () => {
    const db = new BattlePlanDB(`BattlePlan-ledger-event-outbox-${Date.now()}-${Math.random()}`);
    await db.open();
    await ready(db);
    const clock = { now: 1_000 };
    const ledger = ledgerFor(db, clock);
    try {
        const claimed = await ledger.claimCommand(input());
        assert.equal(claimed.status, 'claimed');
        if (claimed.status !== 'claimed') return;
        clock.now = 1_100;
        const event = {
            eventId: EVENT_ID, streamId: 'battleplan-events', producerId: 'battleplan-producer',
            eventType: 'entity_created' as const, entityKind: 'task' as const, entityPublicId: 'task_public_1',
            revision: REVISION, payloadDigest: DIGEST_A, occurredAt: '2026-08-10T12:00:00Z',
            actor: 'battleplan-user', origin: 'ui' as const, causeId: CAUSE_ID,
            projection: { title: 'Safe title' },
        };
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [appliedResultOutbox(), {
                id: 'caller-event', family: 'event', messageId: crypto.randomUUID(),
                payload: { stream_id: 'wrong', sequence_from: '99', sequence_to: '99', events: [] },
            }],
            events: [event],
        }), /Invalid command lifecycle transition/);
        assert.equal(await db.agentProtocolEvents.count(), 0);
        assert.equal(await db.agentProtocolOutbox.count(), 0);

        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [appliedResultOutbox()],
            events: [{ ...event, eventId: 'not-a-uuid' }],
        }), /public protocol contract/);
        await assert.rejects(ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [appliedResultOutbox()],
            events: Array.from({ length: 251 }, () => event),
        }), /Invalid command lifecycle transition/);
        assert.equal(await db.agentProtocolEvents.count(), 0);
        assert.equal(await db.agentProtocolOutbox.count(), 0);

        const finalized = await ledger.finalizeCommand({
            claim: claimed.claim,
            lifecycle: 'applied',
            result: { entityPublicId: 'task_public_1', revision: REVISION },
            outbox: [appliedResultOutbox()],
            events: [event],
        });
        assert.equal(finalized.status, 'finalized');
        assert.equal(await db.agentProtocolEvents.count(), 1);
        const eventOutboxes = await db.agentProtocolOutbox.where('family').equals('event').toArray();
        assert.equal(eventOutboxes.length, 1);
        const eventOutbox = eventOutboxes[0];
        assert.equal(eventOutbox?.family, 'event');
        if (eventOutbox?.family === 'event') {
            assert.equal(eventOutbox.payload.events[0]?.sequence, '1');
        }
    } finally {
        await db.delete();
    }
});
