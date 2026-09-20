import {
    db as defaultDb, type AgentCommandReceiptRow, type AgentEffectState, type AgentProtocolEffectRow, type BattlePlanDB,
} from '../db.ts';
import type { ProtocolEffect, ResultPayload } from './agentProtocol/contracts.ts';
import { validateResultPayloadContract } from './agentProtocol/validation.ts';
import { applyTaskEffectMetadata } from './taskMutations.ts';
import type { CalendarWriteGuard, GoogleService } from './googleService.ts';
import { hasUsableAuth } from '../types.ts';

export interface ExternalEffectExecutionResult { externalId?: string }
type ExternalEffectExecutor = (effect: AgentProtocolEffectRow, guard: CalendarWriteGuard) => Promise<ExternalEffectExecutionResult>;
interface ExternalEffectOutboxOptions {
    execute: ExternalEffectExecutor;
    accountId: () => string | null;
    canExecute?: () => boolean;
    now?: () => number;
    leaseDurationMs?: number;
    executionTimeoutMs?: number;
    scheduleRenewal?: (callback: () => Promise<void>, delayMs: number) => () => void;
}
export interface ExternalEffectDrainResult {
    attempted: number;
    succeeded: number;
    retryScheduled: number;
    failed: number;
}
const ACTIVE_STATES = ['pending', 'retry_scheduled', 'running'];
const isActive = (effect: AgentProtocolEffectRow) => ACTIVE_STATES.includes(effect.state);
function isDue(effect: AgentProtocolEffectRow, now: number) {
    return effect.state === 'pending'
        || (effect.state === 'retry_scheduled' && (effect.nextAttemptAt ?? 0) <= now)
        || (effect.state === 'running' && (effect.leaseExpiresAt ?? 0) <= now);
}
const bySequence = (a: AgentProtocolEffectRow, b: AgentProtocolEffectRow) => a.sequence - b.sequence || a.id.localeCompare(b.id);

function effectStateForProtocol(effect: AgentProtocolEffectRow): ProtocolEffect {
    const base = { effect_id: effect.id, kind: effect.kind };
    if (effect.state === 'succeeded') return { ...base, state: 'succeeded' };
    if (effect.state === 'failed') return { ...base, state: 'failed', error_code: 'external_effect_failed' };
    return { ...base, state: 'pending' };
}
function deriveReceiptEffectState(effects: AgentProtocolEffectRow[]): AgentEffectState {
    if (effects.some((effect) => effect.state === 'failed')) return 'failed';
    if (effects.every((effect) => effect.state === 'succeeded')) return 'succeeded';
    if (effects.some((effect) => effect.state === 'retry_scheduled')) return 'retry_scheduled';
    if (effects.some((effect) => effect.state === 'running')) return 'running';
    return 'pending';
}

/** Only short IndexedDB transactions own claims; no network promise runs in one. */
export class ExternalEffectOutbox {
    private readonly db: BattlePlanDB;
    private readonly options: ExternalEffectOutboxOptions;
    private readonly now: () => number;
    private readonly leaseDurationMs: number;
    private readonly owner = `effect-worker:${crypto.randomUUID()}`;

    constructor(db: BattlePlanDB, options: ExternalEffectOutboxOptions) {
        this.db = db;
        this.options = options;
        this.now = options.now ?? Date.now;
        this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    }

    async drainOnce(effectIds?: readonly string[]): Promise<ExternalEffectDrainResult> {
        const result: ExternalEffectDrainResult = { attempted: 0, succeeded: 0, retryScheduled: 0, failed: 0 };
        const selected = effectIds ? new Set(effectIds) : undefined;
        const active = await this.db.agentProtocolEffects.where('state').anyOf(ACTIVE_STATES).toArray();
        const groups = new Map<string, AgentProtocolEffectRow[]>();
        for (const effect of active) {
            const group = groups.get(effect.entityPublicId) ?? [];
            group.push(effect);
            groups.set(effect.entityPublicId, group);
        }
        // Bound recovery bursts while retaining FIFO within each independent task.
        const queuedGroups = [...groups.values()];
        let nextGroup = 0;
        await Promise.all(Array.from({ length: Math.min(4, queuedGroups.length) }, async () => {
            while (nextGroup < queuedGroups.length) {
                const effects = queuedGroups[nextGroup++];
                for (const effect of effects.sort(bySequence)) {
                    if (selected && !selected.has(effect.id)) break;
                    const claimed = await this.claim(effect.id);
                    if (!claimed) break;
                    result.attempted++;
                    try {
                        const execution = await this.executeWithDeadline(claimed);
                        if (await this.complete(claimed, execution)) result.succeeded++;
                        else break;
                    } catch (error) {
                        const outcome = await this.fail(claimed, error);
                        if (outcome === 'failed') result.failed++;
                        else {
                            if (outcome === 'retry_scheduled') result.retryScheduled++;
                            break;
                        }
                    }
                }
            }
        }));
        return result;
    }

    private async executeWithDeadline(claimed: AgentProtocolEffectRow) {
        let active = true;
        const stopRenewal = this.startRenewal(claimed, () => active);
        const expire = () => {
            if (!active) return;
            active = false;
            stopRenewal();
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                expire();
                reject(new Error('Google effect execution timed out'));
            }, this.options.executionTimeoutMs ?? 60_000);
        });
        try {
            // gapi cannot cancel an issued request. Revoke follow-up writes; stable
            // Calendar IDs/ETags and complete-only Tasks writes protect late sends.
            return await Promise.race([deadline, this.options.execute(structuredClone(claimed), {
                isCurrent: async () => active && await this.isCurrent(claimed) && active,
            })]);
        } finally {
            expire();
            clearTimeout(timer);
        }
    }

    private sessionMatches(effect: AgentProtocolEffectRow) {
        return Boolean(effect.accountId && this.options.accountId() === effect.accountId
            && (this.options.canExecute?.() ?? true));
    }

    private async claim(id: string): Promise<AgentProtocolEffectRow | undefined> {
        return this.db.transaction('rw', [this.db.agentProtocolEffects, this.db.agentCommandReceipts], async () => {
            const effect = await this.db.agentProtocolEffects.get(id);
            if (!effect || !isDue(effect, this.now()) || !this.sessionMatches(effect)) return;
            const siblings = await this.db.agentProtocolEffects.where('entityPublicId').equals(effect.entityPublicId).toArray();
            if (siblings.filter(isActive).sort(bySequence)[0]?.id !== id) return;
            const claimed: AgentProtocolEffectRow = {
                ...effect, state: 'running', attempts: effect.attempts + 1,
                fencingToken: effect.fencingToken + 1, leaseOwner: this.owner,
                leaseExpiresAt: this.now() + this.leaseDurationMs, nextAttemptAt: undefined, updatedAt: this.now(),
            };
            await this.db.agentProtocolEffects.put(claimed);
            if (claimed.commandReceiptId) await this.syncReceipt(claimed.commandReceiptId);
            return claimed;
        });
    }

    private owns(current: AgentProtocolEffectRow | undefined, claimed: AgentProtocolEffectRow): current is AgentProtocolEffectRow {
        return current?.state === 'running' && current.leaseOwner === this.owner
            && current.fencingToken === claimed.fencingToken && (current.leaseExpiresAt ?? 0) > this.now();
    }

    private async isCurrent(claimed: AgentProtocolEffectRow) {
        return this.owns(await this.db.agentProtocolEffects.get(claimed.id), claimed) && this.sessionMatches(claimed);
    }

    private startRenewal(claimed: AgentProtocolEffectRow, isActive: () => boolean) {
        const callback = () => {
            if (!isActive()) return Promise.resolve();
            return this.db.transaction('rw', this.db.agentProtocolEffects, async () => {
                const current = await this.db.agentProtocolEffects.get(claimed.id);
                if (!isActive() || !this.owns(current, claimed) || !this.sessionMatches(claimed)) return;
                await this.db.agentProtocolEffects.update(claimed.id, { leaseExpiresAt: this.now() + this.leaseDurationMs });
            }).catch(() => { /* A failed renewal loses ownership; the pre-send guard and acknowledgement enforce it. */ });
        };
        const delay = Math.max(1, Math.floor(this.leaseDurationMs / 3));
        if (this.options.scheduleRenewal) return this.options.scheduleRenewal(callback, delay);
        const timer = setInterval(callback, delay);
        return () => clearInterval(timer);
    }

    private async complete(claimed: AgentProtocolEffectRow, execution: ExternalEffectExecutionResult) {
        return this.db.transaction('rw', [this.db.agentProtocolEffects, this.db.agentCommandReceipts,
            this.db.agentProtocolOutbox, this.db.tasks], async () => {
            const current = await this.db.agentProtocolEffects.get(claimed.id);
            if (!this.owns(current, claimed) || !this.sessionMatches(claimed)) return false;
            if (current.kind === 'calendar' && current.operation === 'upsert') {
                const expectedTarget = current.payload.googleEventId ?? current.payload.reservedEventId;
                if (execution.externalId !== expectedTarget) throw new Error('Calendar returned an unexpected event identity');
                await applyTaskEffectMetadata(this.db, current.entityPublicId, execution.externalId, expectedTarget);
            }
            const completed: AgentProtocolEffectRow = { ...current, state: 'succeeded', leaseOwner: undefined,
                leaseExpiresAt: undefined, nextAttemptAt: undefined, lastErrorCode: undefined,
                lastErrorMessage: undefined, updatedAt: this.now() };
            await this.db.agentProtocolEffects.put(completed);
            await this.queueCommandResult(completed);
            return true;
        });
    }

    private async fail(claimed: AgentProtocolEffectRow, error: unknown) {
        return this.db.transaction('rw', [this.db.agentProtocolEffects, this.db.agentCommandReceipts,
            this.db.agentProtocolOutbox], async () => {
            const current = await this.db.agentProtocolEffects.get(claimed.id);
            if (!this.owns(current, claimed)) return 'fence_lost';
            const status = (error as { status?: number } | null)?.status;
            const terminal = status !== undefined && status >= 400 && status < 500 && ![401, 403, 408, 409, 412, 429].includes(status);
            const failed: AgentProtocolEffectRow = {
                ...current, state: terminal ? 'failed' : 'retry_scheduled', leaseOwner: undefined, leaseExpiresAt: undefined,
                nextAttemptAt: terminal ? undefined : this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(6, current.attempts - 1)),
                lastErrorCode: terminal ? 'external_effect_failed' : 'transport_retryable',
                lastErrorMessage: terminal ? `Google odmítl zápis (${status}). Opravte úkol a zkuste synchronizaci znovu.`
                    : status === 401 || status === 403 ? 'Zápis čeká na přihlášení nebo oprávnění Google.'
                    : 'Zápis do Google čeká na další pokus.',
                updatedAt: this.now(),
            };
            await this.db.agentProtocolEffects.put(failed);
            await this.queueCommandResult(failed, terminal);
            return failed.state;
        });
    }

    private async syncReceipt(commandReceiptId: string): Promise<{ receipt: AgentCommandReceiptRow; effects: AgentProtocolEffectRow[] } | undefined> {
        const [receipt, effects] = await Promise.all([this.db.agentCommandReceipts.get(commandReceiptId),
            this.db.agentProtocolEffects.where('commandReceiptId').equals(commandReceiptId).toArray()]);
        if (!receipt || !effects.length) return;
        const updated = { ...receipt, effectState: deriveReceiptEffectState(effects), updatedAt: this.now() };
        await this.db.agentCommandReceipts.put(updated);
        return { receipt: updated, effects };
    }

    private async queueCommandResult(effect: AgentProtocolEffectRow, publish = true) {
        if (!effect.commandReceiptId) return;
        const state = await this.syncReceipt(effect.commandReceiptId);
        const result = state?.receipt.result;
        if (!publish || !state || !result?.entityPublicId || !result.revision) return;
        const payload: ResultPayload = { command_id: state.receipt.commandId, state: 'applied',
            entity_public_id: result.entityPublicId, revision: result.revision, effects: state.effects.map(effectStateForProtocol) };
        if (!validateResultPayloadContract(payload)) throw new TypeError('Generated effect result violates protocol contract');
        await this.db.agentProtocolOutbox.put({ id: `effect-result\0${effect.id}\0${effect.state}`, family: 'result',
            messageId: crypto.randomUUID(), payload, commandReceiptId: effect.commandReceiptId,
            fencingToken: state.receipt.fencingToken, status: 'pending', attempts: 0, createdAt: this.now(), updatedAt: this.now() });
    }
}

type GoogleEffectClient = Pick<GoogleService, 'addToCalendar' | 'deleteFromCalendar' | 'updateGoogleTask'>;
export async function executeGoogleExternalEffect(client: GoogleEffectClient, effect: AgentProtocolEffectRow,
    guard: CalendarWriteGuard): Promise<ExternalEffectExecutionResult> {
    if (!await guard.isCurrent()) throw new Error('External effect ownership unavailable');
    if (effect.kind === 'calendar' && effect.operation === 'upsert') {
        const externalId = await client.addToCalendar({ ...effect.payload, reservedGoogleEventId: effect.payload.reservedEventId }, guard);
        if (!externalId) throw new Error('Google Calendar unavailable');
        return { externalId };
    }
    if (effect.kind === 'calendar' && effect.operation === 'delete') {
        if (await client.deleteFromCalendar(effect.payload.eventId, guard) !== true) throw new Error('Google Calendar unavailable');
        return {};
    }
    if (effect.kind === 'google_tasks' && effect.operation === 'complete') {
        if (!await client.updateGoogleTask(effect.payload.googleTaskId, { status: 'completed' }, effect.payload.googleListId, guard)) {
            throw new Error('Google Tasks unavailable');
        }
        return {};
    }
    throw new Error('Unsupported external effect');
}

/** Unknown destinations are bound only by an explicit mutation/Sync action, never by this background worker. */
export async function drainGoogleExternalEffects(effectIds?: readonly string[]): Promise<ExternalEffectDrainResult> {
    const { googleService } = await import('./googleService.ts');
    return new ExternalEffectOutbox(defaultDb, {
        accountId: () => googleService.getAccountId(),
        canExecute: () => (typeof navigator === 'undefined' || navigator.onLine !== false) && hasUsableAuth(googleService.getAuthStatus()),
        execute: (effect, guard) => executeGoogleExternalEffect(googleService, effect, guard),
    }).drainOnce(effectIds);
}

/** Failed records remain inspectable; a later successful delivery of the same kind resolves their visible warning. */
export function summarizeExternalEffects(effects: AgentProtocolEffectRow[], accountId: string | null) {
    const latestSuccess = new Map<string, number>();
    for (const effect of effects) {
        if (effect.state !== 'succeeded') continue;
        const key = `${effect.entityPublicId}\0${effect.kind}`;
        latestSuccess.set(key, Math.max(latestSuccess.get(key) ?? 0, effect.sequence));
    }
    const pending = effects.filter(isActive);
    const failed = effects.filter((effect) => effect.state === 'failed'
        && (latestSuccess.get(`${effect.entityPublicId}\0${effect.kind}`) ?? 0) <= effect.sequence);
    return {
        pending: pending.length, failed: failed.length,
        accountBlocked: pending.filter((effect) => !effect.accountId || effect.accountId !== accountId).length,
        lastError: failed[0]?.lastErrorMessage ?? pending.find((effect) => effect.lastErrorMessage)?.lastErrorMessage ?? null,
        lastSuccess: effects.reduce<number | null>((latest, effect) => effect.state === 'succeeded'
            ? Math.max(latest ?? 0, effect.updatedAt) : latest, null),
        wakeKey: pending.map((effect) => `${effect.id}:${effect.state}:${effect.nextAttemptAt ?? ''}`).sort().join('|'),
    };
}

/** Browser lifecycle coordination; stopping prevents new work but leaves already-issued requests owned by their lease. */
export function createExternalEffectScheduler(options: {
    drain: () => Promise<unknown>;
    onError?: (error: unknown) => void;
    schedule?: (callback: () => void) => () => void;
}) {
    let enabled = false;
    let stopped = false;
    let running: Promise<void> | undefined;
    let requested = false;
    let cancelTimer: (() => void) | undefined;
    const schedule = options.schedule ?? ((callback: () => void) => {
        const timer = setTimeout(callback, 15_000);
        return () => clearTimeout(timer);
    });
    const wake = (): Promise<void> => {
        if (stopped || !enabled) return Promise.resolve();
        if (running) { requested = true; return running; }
        cancelTimer?.();
        cancelTimer = undefined;
        running = options.drain().then(() => {}, (error) => {
            if (!stopped) options.onError?.(error);
        }).finally(() => {
            running = undefined;
            if (stopped || !enabled) return;
            if (requested) { requested = false; void wake(); }
            else cancelTimer = schedule(() => { void wake(); });
        });
        return running;
    };
    return {
        wake,
        setEnabled(value: boolean) {
            enabled = value;
            if (enabled) void wake();
            else { cancelTimer?.(); cancelTimer = undefined; requested = false; }
        },
        stop() { stopped = true; cancelTimer?.(); cancelTimer = undefined; requested = false; },
    };
}
