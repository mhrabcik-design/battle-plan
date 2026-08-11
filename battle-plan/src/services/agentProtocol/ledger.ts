import type {
    AgentCommandLifecycle,
    AgentCommandReceiptHistoryEntry,
    AgentCommandReceiptRow,
    AgentConsumerStateRow,
    AgentPairingKeyRow,
    AgentProtocolEventRow,
    AgentProtocolEffectRow,
    AgentProtocolOutboxRow,
    BattlePlanDB,
} from '../../db.ts';
import type { Table } from 'dexie';
import {
    PROTOCOL_RETENTION,
    type EventBatchPayload,
    type ProtocolErrorCode,
    type ProtocolRevision,
    type ResultPayload,
} from './contracts.ts';
import {
    isVerifiedSnapshotProof,
    validateEventBatchPayloadContract,
    validateResultPayloadContract,
    type VerifiedSnapshotProof,
} from './validation.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
export const TERMINAL_RECEIPT_RETENTION_MS = PROTOCOL_RETENTION.idempotencyDays * DAY_MS;
export const CONSUMER_INACTIVITY_MS = PROTOCOL_RETENTION.inactiveConsumerResnapshotDays * DAY_MS;

type Sha256Digest = `sha256:${string}`;

export interface ClaimCommandInput {
    commandId: string;
    payloadDigest: Sha256Digest;
    producerId: string;
    targetReceiverId: string;
    localReceiverId: string;
    expiresAt: number;
    leaseOwner: string;
    leaseDurationMs: number;
}

export interface CommandClaimToken {
    receiptId: string;
    commandId: string;
    payloadDigest: Sha256Digest;
    receiverId: string;
    commandExpiresAt: number;
    leaseOwner: string;
    fencingToken: number;
}

export type ClaimCommandResult =
    | { status: 'claimed'; claim: CommandClaimToken; receipt: AgentCommandReceiptRow }
    | { status: 'replay'; receipt: AgentCommandReceiptRow }
    | { status: 'conflict'; errorCode: 'idempotency_conflict'; conflictId: string }
    | { status: 'quarantined'; reason: 'schema_invalid' | 'target_mismatch' | 'message_expired' | 'receiver_disabled' };

interface PendingOutboxBase {
    id: string;
    messageId: string;
    payloadDigest?: Sha256Digest;
}

export type PendingOutboxInput = PendingOutboxBase & (
    | { family: 'result'; payload: ResultPayload }
    | { family: 'event'; payload: EventBatchPayload }
    | { family: 'snapshot'; payload: Extract<AgentProtocolOutboxRow, { family: 'snapshot' }>['payload'] }
    | { family: 'response'; payload: Extract<AgentProtocolOutboxRow, { family: 'response' }>['payload'] }
    | { family: 'capability'; payload: Extract<AgentProtocolOutboxRow, { family: 'capability' }>['payload'] }
);

type PendingEffectFields =
    | 'commandReceiptId' | 'state' | 'attempts' | 'fencingToken'
    | 'leaseOwner' | 'leaseExpiresAt' | 'nextAttemptAt' | 'lastErrorCode'
    | 'lastErrorMessage' | 'createdAt' | 'updatedAt';
export type PendingEffectInput = AgentProtocolEffectRow extends infer T
    ? T extends AgentProtocolEffectRow ? Omit<T, PendingEffectFields> : never
    : never;

export interface PendingEventInput {
    eventId: string;
    streamId: string;
    producerId: string;
    eventType: AgentProtocolEventRow['eventType'];
    entityKind: AgentProtocolEventRow['entityKind'];
    entityPublicId: string;
    revision: ProtocolRevision;
    payloadDigest: Sha256Digest;
    conflictHeads?: string[];
    occurredAt: string;
    actor: string;
    origin: AgentProtocolEventRow['origin'];
    causeId: string;
    projection: AgentProtocolEventRow['projection'];
}

interface FinalizeCommandBase {
    claim: CommandClaimToken;
    result?: AgentCommandReceiptRow['result'];
    outbox?: PendingOutboxInput[];
    effects?: PendingEffectInput[];
    events?: PendingEventInput[];
}

export type FinalizeCommandInput = FinalizeCommandBase & (
    | { lifecycle: 'awaiting_approval'; errorCode?: never; retryAt?: never }
    | { lifecycle: 'retry_scheduled'; errorCode: 'transport_retryable'; retryAt: number }
    | { lifecycle: 'applied'; errorCode?: never; retryAt?: never }
    | { lifecycle: 'blocked'; errorCode: 'policy_blocked' | 'capability_blocked'; retryAt?: never }
    | { lifecycle: 'stale'; errorCode: 'revision_stale' | 'revision_conflict' | 'approval_stale'; retryAt?: never }
    | { lifecycle: 'expired'; errorCode: 'message_expired' | 'idempotency_horizon_expired'; retryAt?: never }
    | { lifecycle: 'rejected'; errorCode: 'idempotency_conflict'; retryAt?: never }
);

export type FinalizeCommandResult =
    | { status: 'finalized'; receipt: AgentCommandReceiptRow }
    | { status: 'expired'; receipt: AgentCommandReceiptRow }
    | { status: 'fence_lost' };

const RECEIPT_SEPARATOR = '\0';
const DECIMAL_COUNTER = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID = /^(?:[Uu][Rr][Nn]:[Uu][Uu][Ii][Dd]:)?[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/;
const IDENTITY = /^[a-z][a-z0-9._:-]{2,127}$/;

function receiptId(receiverId: string, commandId: string): string {
    return `${receiverId}${RECEIPT_SEPARATOR}${commandId}`;
}

function consumerStateId(consumerId: string, streamId: string): string {
    return `${consumerId}${RECEIPT_SEPARATOR}${streamId}`;
}

function snapshotProvenance(current: AgentConsumerStateRow | undefined) {
    return current ? {
        lastSnapshotMessageId: current.lastSnapshotMessageId,
        lastSnapshotContentSha256: current.lastSnapshotContentSha256,
        lastSnapshotPairingRecordId: current.lastSnapshotPairingRecordId,
        lastSnapshotContractArtifactSha256: current.lastSnapshotContractArtifactSha256,
    } : {};
}

function pairingMatchesProof(
    pairing: AgentPairingKeyRow | undefined,
    proof: VerifiedSnapshotProof,
): pairing is AgentPairingKeyRow {
    return pairing?.status === 'active'
        && pairing.workspaceId === proof.workspaceId
        && pairing.producerId === proof.producerId
        && pairing.receiverId === proof.receiverId
        && pairing.keyId === proof.signingKeyId
        && pairing.pairingEpoch === proof.pairingEpoch
        && pairing.publicKey === proof.rawPublicKey
        && pairing.fingerprint === proof.keyFingerprint
        && pairing.protocolVersion === proof.protocolVersion
        && pairing.contractArtifact?.id === proof.contractArtifact.id
        && pairing.contractArtifact?.version === proof.contractArtifact.version
        && pairing.contractArtifact?.sha256 === proof.contractArtifact.sha256;
}

function historyEntry(
    receipt: AgentCommandReceiptRow,
    lifecycle: AgentCommandLifecycle,
    at: number,
    errorCode?: ProtocolErrorCode,
): AgentCommandReceiptHistoryEntry {
    return {
        id: `${receipt.id}${RECEIPT_SEPARATOR}${receipt.historyCount}`,
        receiptId: receipt.id,
        entryIndex: receipt.historyCount,
        lifecycle,
        at,
        fencingToken: receipt.fencingToken,
        errorCode,
    };
}

function validClaimInput(input: ClaimCommandInput): boolean {
    return UUID.test(input.commandId)
        && IDENTITY.test(input.producerId)
        && IDENTITY.test(input.targetReceiverId)
        && IDENTITY.test(input.localReceiverId)
        && IDENTITY.test(input.leaseOwner)
        && SHA256.test(input.payloadDigest)
        && Number.isFinite(input.expiresAt)
        && Number.isFinite(input.leaseDurationMs)
        && input.leaseDurationMs > 0;
}

function validResultPayload(
    payload: unknown,
    input: FinalizeCommandInput,
): payload is ResultPayload {
    if (!validateResultPayloadContract(payload)) return false;
    const result = payload;
    if (result.command_id !== input.claim.commandId || result.state !== input.lifecycle) return false;

    switch (result.state) {
        case 'awaiting_approval':
            return input.lifecycle === 'awaiting_approval' && input.errorCode == null;
        case 'applied':
            return input.lifecycle === 'applied'
                && input.result?.entityPublicId === result.entity_public_id
                && input.result.revision?.revision_id === result.revision.revision_id
                && input.result.revision.base_revision === result.revision.base_revision
                && input.result.revision.mutation_id === result.revision.mutation_id
                && input.errorCode == null;
        case 'retry_scheduled': {
            const retryAt = Date.parse(result.retry_at);
            return input.lifecycle === 'retry_scheduled'
                && result.error_code === 'transport_retryable'
                && Number.isFinite(retryAt)
                && retryAt === input.retryAt;
        }
        case 'blocked':
        case 'stale':
        case 'expired':
        case 'rejected':
            return result.state === input.lifecycle && result.error_code === input.errorCode;
    }
}

function validFinalizeInput(input: FinalizeCommandInput): boolean {
    if (!UUID.test(input.claim.commandId)
        || !IDENTITY.test(input.claim.receiverId)
        || !input.claim.receiptId
        || !SHA256.test(input.claim.payloadDigest)
        || !Number.isFinite(input.claim.commandExpiresAt)
        || !IDENTITY.test(input.claim.leaseOwner)
        || !Number.isSafeInteger(input.claim.fencingToken)
        || input.claim.fencingToken <= 0) return false;
    const outbox = input.outbox ?? [];
    if (outbox.some((row) => row.family === 'event')) return false;
    if (outbox.some((row) => !row.id || !UUID.test(row.messageId) || !row.payload)) return false;
    if ((input.events?.length ?? 0) > 250) return false;
    const resultRows = outbox.filter((row) => row.family === 'result');
    const resultPayload = resultRows.length === 1 ? resultRows[0]!.payload : undefined;
    if (!validResultPayload(resultPayload, input)) return false;
    const payloadErrorCode = 'error_code' in resultPayload ? resultPayload.error_code : undefined;
    if (payloadErrorCode !== input.errorCode) return false;

    switch (input.lifecycle) {
        case 'awaiting_approval':
        case 'applied':
            return input.errorCode == null && input.retryAt == null;
        case 'retry_scheduled':
            return input.errorCode === 'transport_retryable' && Number.isFinite(input.retryAt);
        case 'blocked':
            return input.errorCode === 'policy_blocked' || input.errorCode === 'capability_blocked';
        case 'stale':
            return input.errorCode === 'revision_stale'
                || input.errorCode === 'revision_conflict'
                || input.errorCode === 'approval_stale';
        case 'expired':
            return input.errorCode === 'message_expired' || input.errorCode === 'idempotency_horizon_expired';
        case 'rejected':
            return input.errorCode === 'idempotency_conflict';
    }
}

async function terminalizeReceipt(
    db: BattlePlanDB,
    receipt: AgentCommandReceiptRow,
    lifecycle: 'expired' | 'blocked',
    errorCode: 'message_expired' | 'capability_blocked',
    now: number,
): Promise<AgentCommandReceiptRow> {
    const terminalReceipt: AgentCommandReceiptRow = {
        ...receipt,
        lifecycle,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        retryAt: undefined,
        result: { ...receipt.result, errorCode },
        historyCount: receipt.historyCount + 1,
        updatedAt: now,
        retainUntil: Math.max(receipt.retainUntil, now + TERMINAL_RECEIPT_RETENTION_MS),
    };
    const resultPayload: ResultPayload = lifecycle === 'expired'
        ? { command_id: receipt.commandId, state: 'expired', error_code: 'message_expired' }
        : { command_id: receipt.commandId, state: 'blocked', error_code: 'capability_blocked' };
    await db.agentCommandReceipts.put(terminalReceipt);
    await db.agentCommandReceiptHistory.add(historyEntry(terminalReceipt, lifecycle, now, errorCode));
    await db.agentProtocolOutbox.add({
        id: `${lifecycle}${RECEIPT_SEPARATOR}${receipt.id}`,
        family: 'result',
        messageId: crypto.randomUUID(),
        payload: resultPayload,
        commandReceiptId: receipt.id,
        fencingToken: receipt.fencingToken,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
    });
    return terminalReceipt;
}

function freshUnownedReceipt(input: ClaimCommandInput, now: number): AgentCommandReceiptRow {
    return {
        id: receiptId(input.localReceiverId, input.commandId),
        commandId: input.commandId,
        payloadDigest: input.payloadDigest,
        producerId: input.producerId,
        receiverId: input.localReceiverId,
        commandExpiresAt: input.expiresAt,
        lifecycle: 'executing',
        effectState: 'none',
        fencingToken: 0,
        attempts: 0,
        historyCount: 0,
        createdAt: now,
        updatedAt: now,
        retainUntil: now + TERMINAL_RECEIPT_RETENTION_MS,
    };
}

export class AgentProtocolLedger {
    private readonly db: BattlePlanDB;
    private readonly clock: () => number;

    constructor(db: BattlePlanDB, clock: () => number = Date.now) {
        this.db = db;
        this.clock = clock;
    }

    private readNow(): number {
        const now = this.clock();
        if (!Number.isFinite(now)) throw new TypeError('Protocol clock must return a finite timestamp');
        return now;
    }

    /**
     * The only durable ownership boundary. Signature/schema verification must
     * already have succeeded; target/capability/expiry are rechecked in the
     * short read-write transaction before an executing receipt can exist.
     */
    async claimCommand(input: ClaimCommandInput): Promise<ClaimCommandResult> {
        const command = structuredClone(input);
        if (!validClaimInput(command)) return { status: 'quarantined', reason: 'schema_invalid' };
        if (command.targetReceiverId !== command.localReceiverId) {
            return { status: 'quarantined', reason: 'target_mismatch' };
        }

        return this.db.transaction(
            'rw',
            [
                this.db.agentReceiverCapabilities,
                this.db.agentCommandReceipts,
                this.db.agentCommandReceiptHistory,
                this.db.agentCommandConflicts,
                this.db.agentProtocolOutbox,
            ],
            async () => {
                const now = this.readNow();
                const id = receiptId(command.localReceiverId, command.commandId);
                const existing = await this.db.agentCommandReceipts.get(id);
                if (existing && existing.payloadDigest !== command.payloadDigest) {
                    const conflictId = `${id}${RECEIPT_SEPARATOR}${command.payloadDigest}`;
                    if (!await this.db.agentCommandConflicts.get(conflictId)) {
                        await this.db.agentCommandConflicts.add({
                            id: conflictId,
                            receiptId: id,
                            commandId: command.commandId,
                            receiverId: command.localReceiverId,
                            originalDigest: existing.payloadDigest,
                            conflictingDigest: command.payloadDigest,
                            lifecycle: 'blocked',
                            errorCode: 'idempotency_conflict',
                            createdAt: now,
                            retainUntil: now + TERMINAL_RECEIPT_RETENTION_MS,
                        });
                        await this.db.agentProtocolOutbox.add({
                            id: `conflict${RECEIPT_SEPARATOR}${conflictId}`,
                            family: 'result',
                            messageId: crypto.randomUUID(),
                            payload: {
                                command_id: command.commandId,
                                state: 'rejected',
                                error_code: 'idempotency_conflict',
                            },
                            commandReceiptId: existing.id,
                            status: 'pending',
                            attempts: 0,
                            createdAt: now,
                            updatedAt: now,
                        });
                    }
                    return { status: 'conflict', errorCode: 'idempotency_conflict', conflictId } as const;
                }

                const canReclaimExpiredLease = existing?.lifecycle === 'executing'
                    && existing.leaseExpiresAt != null
                    && existing.leaseExpiresAt <= now;
                const canRunScheduledRetry = existing?.lifecycle === 'retry_scheduled'
                    && existing.retryAt != null
                    && existing.retryAt <= now;
                const canReclaim = canReclaimExpiredLease || canRunScheduledRetry;
                const existingIsNonTerminal = existing?.lifecycle === 'executing'
                    || existing?.lifecycle === 'retry_scheduled'
                    || existing?.lifecycle === 'awaiting_approval';
                if (existing && !existingIsNonTerminal) return { status: 'replay', receipt: existing } as const;
                const legacyExpiryMissing = existing != null && !Number.isFinite(existing.commandExpiresAt);
                const commandExpiresAt = existing
                    ? (legacyExpiryMissing ? 0 : existing.commandExpiresAt)
                    : command.expiresAt;
                const normalizedExisting = existing ? { ...existing, commandExpiresAt } : undefined;
                if (commandExpiresAt <= now) {
                    return {
                        status: 'replay',
                        receipt: await terminalizeReceipt(
                            this.db,
                            normalizedExisting ?? freshUnownedReceipt(command, now),
                            'expired',
                            'message_expired',
                            now,
                        ),
                    } as const;
                }
                if (existing && !canReclaim) return { status: 'replay', receipt: existing } as const;

                const receiver = await this.db.agentReceiverCapabilities.get(command.localReceiverId);
                if (!receiver?.enabled || receiver.status !== 'ready') {
                    return {
                        status: 'replay',
                        receipt: await terminalizeReceipt(
                            this.db,
                            normalizedExisting ?? freshUnownedReceipt(command, now),
                            'blocked',
                            'capability_blocked',
                            now,
                        ),
                    } as const;
                }

                const fencingToken = (existing?.fencingToken ?? 0) + 1;
                const attempts = (existing?.attempts ?? 0) + 1;
                const receipt: AgentCommandReceiptRow = {
                    id,
                    commandId: command.commandId,
                    payloadDigest: command.payloadDigest,
                    producerId: command.producerId,
                    receiverId: command.localReceiverId,
                    commandExpiresAt,
                    lifecycle: 'executing',
                    effectState: existing?.effectState ?? 'none',
                    leaseOwner: command.leaseOwner,
                    leaseExpiresAt: now + command.leaseDurationMs,
                    retryAt: undefined,
                    fencingToken,
                    attempts,
                    result: existing?.result,
                    historyCount: (existing?.historyCount ?? 0) + 1,
                    createdAt: existing?.createdAt ?? now,
                    updatedAt: now,
                    retainUntil: existing?.retainUntil ?? now + TERMINAL_RECEIPT_RETENTION_MS,
                };
                await this.db.agentCommandReceipts.put(receipt);
                await this.db.agentCommandReceiptHistory.add(historyEntry(
                    receipt,
                    'executing',
                    now,
                ));
                return {
                    status: 'claimed',
                    receipt,
                    claim: {
                        receiptId: id,
                        commandId: command.commandId,
                        payloadDigest: command.payloadDigest,
                        receiverId: command.localReceiverId,
                        commandExpiresAt,
                        leaseOwner: command.leaseOwner,
                        fencingToken,
                    },
                } as const;
            },
        );
    }

    /**
     * Primitive for a later domain-command transaction. Domain tables and
     * event rows join this outer transaction; external promises never do.
     */
    async finalizeCommand(input: FinalizeCommandInput): Promise<FinalizeCommandResult> {
        return this.commitFencedMutation(input, [], async () => undefined);
    }

    /**
     * Opens the outer transaction used by U4/U5. `mutation` may perform only
     * IndexedDB work against the supplied tables. Throwing at any injected
     * crash point rolls back the domain write, receipt transition, effects,
     * and protocol outbox together.
     */
    async commitFencedMutation<T>(
        input: FinalizeCommandInput,
        domainTables: Table[],
        mutation: () => Promise<T>,
    ): Promise<(FinalizeCommandResult & { value?: T })> {
        const finalization = structuredClone(input);
        if (!validFinalizeInput(finalization)) throw new TypeError('Invalid command lifecycle transition');
        return this.db.transaction(
            'rw',
            [
                this.db.agentCommandReceipts,
                this.db.agentCommandReceiptHistory,
                this.db.agentProtocolOutbox,
                this.db.agentProtocolEffects,
                this.db.agentEventStreams,
                this.db.agentProtocolEvents,
                ...domainTables,
            ],
            async () => {
                const now = this.readNow();
                const current = await this.db.agentCommandReceipts.get(finalization.claim.receiptId);
                if (!current
                    || current.lifecycle !== 'executing'
                    || current.id !== receiptId(finalization.claim.receiverId, finalization.claim.commandId)
                    || current.commandId !== finalization.claim.commandId
                    || current.payloadDigest !== finalization.claim.payloadDigest
                    || current.receiverId !== finalization.claim.receiverId
                    || current.commandExpiresAt !== finalization.claim.commandExpiresAt
                    || current.leaseOwner !== finalization.claim.leaseOwner
                    || current.fencingToken !== finalization.claim.fencingToken
                    || current.leaseExpiresAt == null) {
                    return { status: 'fence_lost' } as const;
                }

                if (current.commandExpiresAt <= now) {
                    return {
                        status: 'expired',
                        receipt: await terminalizeReceipt(
                            this.db,
                            current,
                            'expired',
                            'message_expired',
                            now,
                        ),
                    } as const;
                }
                if (current.leaseExpiresAt <= now) return { status: 'fence_lost' } as const;

                if (finalization.lifecycle === 'retry_scheduled' && finalization.retryAt <= now) {
                    throw new TypeError('retry_scheduled requires a future retryAt');
                }

                const effectState = finalization.effects?.length ? 'pending' : current.effectState;
                const receipt: AgentCommandReceiptRow = {
                    ...current,
                    lifecycle: finalization.lifecycle,
                    effectState,
                    leaseOwner: undefined,
                    leaseExpiresAt: undefined,
                    retryAt: finalization.lifecycle === 'retry_scheduled' ? finalization.retryAt : undefined,
                    result: finalization.result,
                    historyCount: current.historyCount + 1,
                    updatedAt: now,
                    retainUntil: Math.max(current.retainUntil, now + TERMINAL_RECEIPT_RETENTION_MS),
                };

                const outboxRows: AgentProtocolOutboxRow[] = (finalization.outbox ?? []).map((row) => ({
                    ...row,
                    commandReceiptId: current.id,
                    fencingToken: current.fencingToken,
                    status: 'pending',
                    attempts: 0,
                    createdAt: now,
                    updatedAt: now,
                }));
                const effectRows: AgentProtocolEffectRow[] = (finalization.effects ?? []).map((effect) => ({
                    ...effect,
                    commandReceiptId: current.id,
                    state: 'pending',
                    attempts: 0,
                    fencingToken: current.fencingToken,
                    createdAt: now,
                    updatedAt: now,
                }));

                const pendingEvents = finalization.events ?? [];
                const streamIds = [...new Set(pendingEvents.map((event) => event.streamId))];
                const streams = await this.db.agentEventStreams.bulkGet(streamIds);
                const streamStates = new Map(
                    streams.flatMap((stream) => stream ? [[stream.streamId, stream] as const] : []),
                );
                const eventRows: AgentProtocolEventRow[] = [];
                for (const event of pendingEvents) {
                    const stream = streamStates.get(event.streamId);
                    if (stream && stream.producerId !== event.producerId) {
                        throw new Error('event_stream_producer_conflict');
                    }
                    const sequence = stream?.nextSequence ?? '1';
                    eventRows.push({
                        ...event,
                        id: `${event.streamId}${RECEIPT_SEPARATOR}${sequence}`,
                        sequence,
                        createdAt: now,
                    });
                    streamStates.set(event.streamId, {
                        streamId: event.streamId,
                        producerId: event.producerId,
                        nextSequence: (BigInt(sequence) + 1n).toString(),
                        updatedAt: now,
                    });
                }

                const eventsByStream = new Map<string, AgentProtocolEventRow[]>();
                for (const event of eventRows) {
                    const batch = eventsByStream.get(event.streamId) ?? [];
                    batch.push(event);
                    eventsByStream.set(event.streamId, batch);
                }
                for (const [streamId, events] of eventsByStream) {
                    const first = events[0]!;
                    const last = events[events.length - 1]!;
                    const payload: EventBatchPayload = {
                        stream_id: streamId,
                        sequence_from: first.sequence,
                        sequence_to: last.sequence,
                        events: events.map((event) => ({
                            event_id: event.eventId,
                            sequence: event.sequence,
                            event_type: event.eventType,
                            entity_kind: event.entityKind,
                            entity_public_id: event.entityPublicId,
                            revision: event.revision,
                            ...(event.conflictHeads ? { conflict_heads: event.conflictHeads } : {}),
                            occurred_at: event.occurredAt,
                            actor: event.actor,
                            origin: event.origin,
                            cause_id: event.causeId,
                            projection: event.projection,
                        })),
                    };
                    if (!validateEventBatchPayloadContract(payload)) {
                        throw new TypeError('Generated event batch violates the public protocol contract');
                    }
                    outboxRows.push({
                        id: `event-batch${RECEIPT_SEPARATOR}${current.id}${RECEIPT_SEPARATOR}${current.fencingToken}${RECEIPT_SEPARATOR}${streamId}${RECEIPT_SEPARATOR}${first.sequence}-${last.sequence}`,
                        family: 'event',
                        messageId: crypto.randomUUID(),
                        payload,
                        commandReceiptId: current.id,
                        fencingToken: current.fencingToken,
                        status: 'pending',
                        attempts: 0,
                        createdAt: now,
                        updatedAt: now,
                    });
                }

                const value = await mutation();
                await this.db.agentCommandReceipts.put(receipt);
                await this.db.agentCommandReceiptHistory.add(historyEntry(
                    receipt,
                    finalization.lifecycle,
                    now,
                    finalization.errorCode,
                ));
                if (streamStates.size) await this.db.agentEventStreams.bulkPut([...streamStates.values()]);
                if (eventRows.length) await this.db.agentProtocolEvents.bulkAdd(eventRows);
                if (outboxRows.length) await this.db.agentProtocolOutbox.bulkAdd(outboxRows);
                if (effectRows.length) await this.db.agentProtocolEffects.bulkAdd(effectRows);
                return { status: 'finalized', receipt, value } as const;
            },
        );
    }

    async reserveEventSequence(streamId: string, producerId: string): Promise<string> {
        if (!IDENTITY.test(streamId) || !IDENTITY.test(producerId)) {
            throw new TypeError('Invalid event stream identity');
        }
        return this.db.transaction('rw', this.db.agentEventStreams, async () => {
            const now = this.readNow();
            const current = await this.db.agentEventStreams.get(streamId);
            if (current && current.producerId !== producerId) throw new Error('event_stream_producer_conflict');
            const sequence = current?.nextSequence ?? '1';
            await this.db.agentEventStreams.put({
                streamId,
                producerId,
                nextSequence: (BigInt(sequence) + 1n).toString(),
                updatedAt: now,
            });
            return sequence;
        });
    }

    async ingestConsumerSequence(input: {
        consumerId: string;
        streamId: string;
        sequence: string;
    }): Promise<{ status: 'advanced' | 'replay' } | { status: 'gap'; expected: string; observed: string }> {
        if (!IDENTITY.test(input.consumerId)
            || !IDENTITY.test(input.streamId)
            || !DECIMAL_COUNTER.test(input.sequence)
            || input.sequence === '0') {
            throw new TypeError('Invalid consumer sequence input');
        }
        const id = consumerStateId(input.consumerId, input.streamId);
        return this.db.transaction('rw', this.db.agentConsumerStates, async () => {
            const now = this.readNow();
            const current = await this.db.agentConsumerStates.get(id);
            const last = BigInt(current?.lastSequence ?? '0');
            const observed = BigInt(input.sequence);
            if (observed <= last) return { status: 'replay' } as const;
            const expected = last + 1n;
            const inactive = current != null && current.inactiveAfter <= now;
            if (current?.requiresSnapshot || inactive || observed !== expected) {
                const state: AgentConsumerStateRow = {
                    ...snapshotProvenance(current),
                    id,
                    consumerId: input.consumerId,
                    streamId: input.streamId,
                    lastSequence: current?.lastSequence ?? '0',
                    gapExpected: current?.gapExpected ?? expected.toString(),
                    gapObserved: current?.gapObserved ?? input.sequence,
                    requiresSnapshot: true,
                    inactiveAfter: now + CONSUMER_INACTIVITY_MS,
                    updatedAt: now,
                };
                await this.db.agentConsumerStates.put(state);
                return { status: 'gap', expected: state.gapExpected!, observed: state.gapObserved! } as const;
            }
            await this.db.agentConsumerStates.put({
                ...snapshotProvenance(current),
                id,
                consumerId: input.consumerId,
                streamId: input.streamId,
                lastSequence: input.sequence,
                requiresSnapshot: false,
                inactiveAfter: now + CONSUMER_INACTIVITY_MS,
                updatedAt: now,
            });
            return { status: 'advanced' } as const;
        });
    }

    /** Installs one verifier-bound projection and releases its cursor atomically. */
    async installVerifiedConsumerSnapshot<T>(input: {
        consumerId: string;
        proof: VerifiedSnapshotProof;
        domainTables: Table[];
        installProjection: (payload: VerifiedSnapshotProof['payload']) => Promise<{
            value: T;
            installedEntityCount: number;
        }>;
    }): Promise<{ consumerState: AgentConsumerStateRow; value: T }> {
        if (!IDENTITY.test(input.consumerId)
            || !isVerifiedSnapshotProof(input.proof)
            || input.proof.receiverId !== input.consumerId
            || !IDENTITY.test(input.proof.targetStreamId)
            || input.proof.targetStreamId !== input.proof.payload.stream_id
            || !DECIMAL_COUNTER.test(input.proof.payload.high_water_mark)
            || typeof input.installProjection !== 'function'
            || (!input.domainTables.length && input.proof.payload.entities.length > 0)) {
            throw new TypeError('Verified snapshot recovery capability was not satisfied');
        }
        const proof = input.proof;
        const id = consumerStateId(input.consumerId, proof.targetStreamId);
        return this.db.transaction('rw', [
            this.db.agentConsumerStates,
            this.db.agentPairingKeys,
            ...input.domainTables,
        ], async () => {
            const now = this.readNow();
            const [pairing, current] = await Promise.all([
                this.db.agentPairingKeys.get(proof.pairingRecordId),
                this.db.agentConsumerStates.get(id),
            ]);
            if (!pairingMatchesProof(pairing, proof)) {
                throw new TypeError('Verified snapshot proof is not bound to its active durable pairing');
            }
            if (!current
                || current.consumerId !== proof.receiverId
                || current.streamId !== proof.targetStreamId) {
                throw new TypeError('Verified snapshot proof is not bound to an existing consumer stream');
            }
            if (BigInt(proof.payload.high_water_mark) < BigInt(current.lastSequence)) {
                throw new TypeError('Snapshot high-water mark cannot move backward');
            }
            const installation = await input.installProjection(structuredClone(proof.payload));
            if (!Number.isSafeInteger(installation.installedEntityCount)
                || installation.installedEntityCount !== proof.payload.entities.length) {
                throw new TypeError('Snapshot projection did not install every verified entity');
            }
            const pairingAfterInstallation = await this.db.agentPairingKeys.get(proof.pairingRecordId);
            if (!pairingMatchesProof(pairingAfterInstallation, proof)) {
                throw new TypeError('Verified snapshot pairing changed during installation');
            }
            const recovered: AgentConsumerStateRow = {
                id,
                consumerId: input.consumerId,
                streamId: proof.targetStreamId,
                lastSequence: proof.payload.high_water_mark,
                requiresSnapshot: false,
                lastSnapshotMessageId: proof.messageId,
                lastSnapshotContentSha256: proof.contentSha256,
                lastSnapshotPairingRecordId: proof.pairingRecordId,
                lastSnapshotContractArtifactSha256: proof.contractArtifact.sha256,
                inactiveAfter: now + CONSUMER_INACTIVITY_MS,
                updatedAt: now,
            };
            await this.db.agentConsumerStates.put(recovered);
            return { consumerState: recovered, value: installation.value };
        });
    }
}
