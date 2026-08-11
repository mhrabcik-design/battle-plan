import {
    db as defaultDb,
    type AgentCommandReceiptRow,
    type AgentEffectState,
    type AgentProtocolEffectRow,
    type BattlePlanDB,
} from '../db.ts';
import type { ProtocolEffect, ResultPayload } from './agentProtocol/contracts.ts';
import { validateResultPayloadContract } from './agentProtocol/validation.ts';
import { applyTaskEffectMetadata } from './taskMutations.ts';

export interface ExternalEffectExecutionResult {
    externalId?: string;
}

export type ExternalEffectExecutor = (effect: Readonly<AgentProtocolEffectRow>) => Promise<ExternalEffectExecutionResult>;

interface ExternalEffectOutboxOptions {
    execute: ExternalEffectExecutor;
    now?: () => number;
    uuid?: () => string;
    retryDelayMs?: (attempt: number) => number;
    maxAttempts?: number;
    leaseDurationMs?: number;
}

export interface ExternalEffectDrainResult {
    attempted: number;
    succeeded: number;
    retryScheduled: number;
    failed: number;
}

function effectStateForProtocol(effect: AgentProtocolEffectRow): ProtocolEffect {
    const base = { effect_id: effect.id, kind: effect.kind };
    if (effect.state === 'succeeded') return { ...base, state: 'succeeded' };
    if (effect.state === 'failed') return { ...base, state: 'failed', error_code: 'external_effect_failed' };
    return { ...base, state: 'pending' };
}

function isDue(effect: AgentProtocolEffectRow, now: number): boolean {
    return effect.state === 'pending'
        || (effect.state === 'retry_scheduled' && (effect.nextAttemptAt ?? 0) <= now)
        || (effect.state === 'running' && (effect.leaseExpiresAt ?? 0) <= now);
}

function deriveReceiptEffectState(effects: readonly AgentProtocolEffectRow[]): AgentEffectState {
    if (effects.some((effect) => effect.state === 'failed')) return 'failed';
    if (effects.every((effect) => effect.state === 'succeeded')) return 'succeeded';
    if (effects.some((effect) => effect.state === 'retry_scheduled')) return 'retry_scheduled';
    if (effects.some((effect) => effect.state === 'running')) return 'running';
    return 'pending';
}

export class ExternalEffectOutbox {
    private readonly db: BattlePlanDB;
    private readonly options: ExternalEffectOutboxOptions;
    private readonly readNow: () => number;
    private readonly createUuid: () => string;
    private readonly retryDelayMs: (attempt: number) => number;
    private readonly maxAttempts: number;
    private readonly leaseDurationMs: number;
    private readonly leaseOwner: string;

    constructor(
        db: BattlePlanDB,
        options: ExternalEffectOutboxOptions,
    ) {
        this.db = db;
        this.options = options;
        this.readNow = options.now ?? Date.now;
        this.createUuid = options.uuid ?? (() => crypto.randomUUID());
        this.retryDelayMs = options.retryDelayMs ?? ((attempt) => Math.min(60_000, 1_000 * (2 ** Math.max(0, attempt - 1))));
        this.maxAttempts = options.maxAttempts ?? 3;
        this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
        this.leaseOwner = `effect-worker:${this.createUuid()}`;
    }

    async drainOnce(effectIds?: readonly string[]): Promise<ExternalEffectDrainResult> {
        const now = this.readNow();
        const selectedIds = effectIds ? new Set(effectIds) : undefined;
        const active = await this.db.agentProtocolEffects
            .where('state')
            .anyOf(['pending', 'retry_scheduled', 'running'])
            .toArray();
        const candidates = active.filter((effect) => (!selectedIds || selectedIds.has(effect.id)) && isDue(effect, now));
        const result: ExternalEffectDrainResult = { attempted: 0, succeeded: 0, retryScheduled: 0, failed: 0 };
        for (const candidate of candidates) {
            const claimed = await this.claim(candidate.id);
            if (!claimed) continue;
            result.attempted += 1;
            try {
                const execution = await this.options.execute(structuredClone(claimed));
                if (await this.complete(claimed, execution)) result.succeeded += 1;
            } catch {
                const outcome = await this.fail(claimed);
                if (outcome === 'retry_scheduled') result.retryScheduled += 1;
                if (outcome === 'failed') result.failed += 1;
            }
        }
        return result;
    }

    private async claim(id: string): Promise<AgentProtocolEffectRow | undefined> {
        return this.db.transaction('rw', [this.db.agentProtocolEffects, this.db.agentCommandReceipts], async () => {
            const now = this.readNow();
            const effect = await this.db.agentProtocolEffects.get(id);
            if (!effect || !isDue(effect, now)) return undefined;
            const claimed: AgentProtocolEffectRow = {
                ...effect,
                state: 'running',
                attempts: effect.attempts + 1,
                fencingToken: effect.fencingToken + 1,
                leaseOwner: this.leaseOwner,
                leaseExpiresAt: now + this.leaseDurationMs,
                nextAttemptAt: undefined,
                updatedAt: now,
            };
            await this.db.agentProtocolEffects.put(claimed);
            if (claimed.commandReceiptId) await this.syncCommandEffectState(claimed.commandReceiptId);
            return claimed;
        });
    }

    private async complete(
        claimed: AgentProtocolEffectRow,
        execution: ExternalEffectExecutionResult,
    ): Promise<boolean> {
        return this.db.transaction('rw', [
            this.db.agentProtocolEffects,
            this.db.agentCommandReceipts,
            this.db.agentProtocolOutbox,
            this.db.tasks,
        ], async () => {
            const current = await this.db.agentProtocolEffects.get(claimed.id);
            if (!this.owns(current, claimed)) return false;
            const completed: AgentProtocolEffectRow = {
                ...current,
                state: 'succeeded',
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                nextAttemptAt: undefined,
                lastErrorCode: undefined,
                lastErrorMessage: undefined,
                updatedAt: this.readNow(),
            };
            if (completed.kind === 'calendar' && completed.operation === 'upsert') {
                await applyTaskEffectMetadata(this.db, completed.entityPublicId, execution.externalId);
            }
            await this.db.agentProtocolEffects.put(completed);
            await this.queueCommandEffectResult(completed);
            return true;
        });
    }

    private async fail(claimed: AgentProtocolEffectRow): Promise<'retry_scheduled' | 'failed' | 'fence_lost'> {
        return this.db.transaction('rw', [
            this.db.agentProtocolEffects,
            this.db.agentCommandReceipts,
            this.db.agentProtocolOutbox,
        ], async () => {
            const current = await this.db.agentProtocolEffects.get(claimed.id);
            if (!this.owns(current, claimed)) return 'fence_lost';
            const terminal = current.attempts >= this.maxAttempts;
            const failed: AgentProtocolEffectRow = {
                ...current,
                state: terminal ? 'failed' : 'retry_scheduled',
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                nextAttemptAt: terminal ? undefined : this.readNow() + this.retryDelayMs(current.attempts),
                lastErrorCode: terminal ? 'external_effect_failed' : 'transport_retryable',
                lastErrorMessage: `${current.kind} effect failed`,
                updatedAt: this.readNow(),
            };
            await this.db.agentProtocolEffects.put(failed);
            await this.queueCommandEffectResult(failed, terminal);
            return terminal ? 'failed' : 'retry_scheduled';
        });
    }

    private owns(current: AgentProtocolEffectRow | undefined, claimed: AgentProtocolEffectRow): current is AgentProtocolEffectRow {
        return current?.state === 'running'
            && current.leaseOwner === this.leaseOwner
            && current.fencingToken === claimed.fencingToken;
    }

    private async queueCommandEffectResult(effect: AgentProtocolEffectRow, publish = true): Promise<void> {
        if (!effect.commandReceiptId) return;
        const state = await this.syncCommandEffectState(effect.commandReceiptId);
        const receiptResult = state?.receipt.result;
        if (!state || !receiptResult?.entityPublicId || !receiptResult.revision) return;
        if (!publish) return;
        const { receipt, effects } = state;
        const payload: ResultPayload = {
            command_id: receipt.commandId,
            state: 'applied',
            entity_public_id: receiptResult.entityPublicId,
            revision: receiptResult.revision,
            effects: effects.map(effectStateForProtocol),
        };
        if (!validateResultPayloadContract(payload)) throw new TypeError('Generated external-effect result violates protocol contract');
        await this.db.agentProtocolOutbox.put({
            id: `effect-result\0${effect.id}\0${effect.state}`,
            family: 'result',
            messageId: this.createUuid(),
            payload,
            commandReceiptId: effect.commandReceiptId,
            fencingToken: receipt.fencingToken,
            status: 'pending',
            attempts: 0,
            createdAt: this.readNow(),
            updatedAt: this.readNow(),
        });
    }

    private async syncCommandEffectState(commandReceiptId: string): Promise<{
        receipt: AgentCommandReceiptRow;
        effects: AgentProtocolEffectRow[];
    } | undefined> {
        const [receipt, effects] = await Promise.all([
            this.db.agentCommandReceipts.get(commandReceiptId),
            this.db.agentProtocolEffects.where('commandReceiptId').equals(commandReceiptId).toArray(),
        ]);
        if (!receipt || effects.length === 0) return undefined;
        const updated = { ...receipt, effectState: deriveReceiptEffectState(effects), updatedAt: this.readNow() };
        await this.db.agentCommandReceipts.put(updated);
        return { receipt: updated, effects };
    }
}

/** Browser worker entry point. Google is loaded lazily so the durable core remains source-independent in Node tests. */
export async function drainGoogleExternalEffects(effectIds?: readonly string[]): Promise<ExternalEffectDrainResult> {
    const { googleService } = await import('./googleService.ts');
    const outbox = new ExternalEffectOutbox(defaultDb, {
        execute: async (effect) => {
            if (effect.kind === 'calendar' && effect.operation === 'upsert') {
                const externalId = await googleService.addToCalendar({
                    ...effect.payload,
                    reservedGoogleEventId: effect.payload.reservedEventId,
                });
                if (!externalId) throw new Error('calendar effect unavailable');
                return { externalId };
            }
            if (effect.kind === 'calendar' && effect.operation === 'delete') {
                await googleService.deleteFromCalendar(effect.payload.eventId);
                return {};
            }
            if (effect.kind === 'google_tasks' && effect.operation === 'complete') {
                const updated = await googleService.updateGoogleTask(
                    effect.payload.googleTaskId,
                    { status: 'completed' },
                    effect.payload.googleListId,
                );
                if (!updated) throw new Error('google tasks effect unavailable');
                return {};
            }
            throw new Error('unsupported external effect');
        },
    });
    return outbox.drainOnce(effectIds);
}
