import {
    db as defaultDb, type AgentCommandReceiptRow, type AgentEffectState, type AgentProtocolEffectRow, type BattlePlanDB, type Task,
} from '../db.ts';
import type { ProtocolEffect, ResultPayload } from './agentProtocol/contracts.ts';
import { validateResultPayloadContract } from './agentProtocol/validation.ts';
import { applyTaskEffectMetadata, taskMutationTables } from './taskMutations.ts';
import type { CalendarWriteGuard, GoogleService } from './googleService.ts';
import { rebaseCalendarProjection, calendarScopeMatches, type CalendarWriteAcknowledgement } from './calendarReconciliation.ts';
import { calendarProjectionToTaskSchedule, toCalendarProjection } from './calendarMapping.ts';
import type { CalendarConflict } from './calendarModel.ts';
import { hasUsableAuth } from '../types.ts';
import { calendarEffectDeliveryAllowed } from './calendarDeliveryGate.ts';
import { readCalendarSyncSettings } from './calendarSettings.ts';

export interface ExternalEffectExecutionResult {
    externalId?: string;
    calendar?: CalendarWriteAcknowledgement;
    superseded?: boolean;
    calendarMetadataClock?: number;
}
type ExternalEffectExecutor = (effect: AgentProtocolEffectRow, guard: CalendarWriteGuard) => Promise<ExternalEffectExecutionResult>;
interface ExternalEffectOutboxOptions {
    execute: ExternalEffectExecutor;
    accountId: () => string | null;
    canExecute?: () => boolean;
    canDeliver?: (effect: AgentProtocolEffectRow) => Promise<boolean>;
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

function calendarEffectMatchesTask(effect: AgentProtocolEffectRow, task: Task | undefined) {
    if (effect.kind !== 'calendar') return true;
    const target = effect.operation === 'upsert' ? effect.payload.googleEventId ?? effect.payload.reservedEventId : effect.payload.eventId;
    if (!task?.calendar) return !(effect.operation === 'upsert' && effect.payload.projection);
    const meta = task.calendar;
    return meta.accountId === effect.accountId && meta.eventId === target
        && (!effect.payload.calendarId || effect.payload.calendarId === meta.calendarId)
        && (!effect.payload.canonicalIdentity || effect.payload.canonicalIdentity === meta.canonicalIdentity)
        && (effect.payload.generation === undefined || effect.payload.generation === meta.generation);
}

function isUnacknowledgedCalendarCreate(effect: Extract<AgentProtocolEffectRow, { kind: 'calendar'; operation: 'upsert' }>, task: Task) {
    return task.calendar?.origin === 'local' && !task.googleEventId && !effect.payload.googleEventId
        && task.reservedGoogleEventId === task.calendar.eventId && effect.payload.reservedEventId === task.calendar.eventId;
}

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
                        if (await this.complete(claimed, execution)) {
                            if (execution.superseded) result.failed++;
                            else result.succeeded++;
                        }
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
        let metadataClock: number | undefined;
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
            const execution = async (): Promise<ExternalEffectExecutionResult> => {
                const effect = structuredClone(claimed);
                if (effect.kind === 'calendar') {
                    const task = await this.db.tasks.where('publicId').equals(effect.entityPublicId).first();
                    if (!calendarEffectMatchesTask(effect, task)) return { superseded: true };
                    if (task?.calendar) {
                        metadataClock = task.calendar.metadataUpdatedAt;
                        if (task.calendar.conflict || task.calendar.readonlyReason) throw new Error('Calendar changes require resolution');
                        if (effect.operation === 'upsert') {
                            if (task.calendar.suppressed) return { superseded: true };
                            // A fresh two-way pull may modernize a legacy target. Replay
                            // the current intent, never its old one-way snapshot.
                            if (!effect.payload.projection) {
                                const settings = await readCalendarSyncSettings(this.db, task.calendar.accountId);
                                if (settings?.enabled) {
                                    // An absent reserved create has no common baseline.
                                    // Only the session's committed pull gate can authorize
                                    // it; a linked legacy target still needs a baseline.
                                    if (!task.calendar.baseline && !(isUnacknowledgedCalendarCreate(effect, task)
                                        && this.options.canDeliver && await this.options.canDeliver(effect))) {
                                        throw new Error('Calendar initial pull unavailable');
                                    }
                                    const projection = toCalendarProjection(task, settings.timeZone);
                                    if (!projection) return { superseded: true };
                                    effect.payload = { ...effect.payload, publicId: task.publicId, type: task.type, projection,
                                        previousProjection: task.calendar.baseline, calendarId: task.calendar.calendarId,
                                        canonicalIdentity: task.calendar.canonicalIdentity, generation: task.calendar.generation };
                                }
                            }
                            if (effect.payload.projection) {
                                effect.payload.sentProjection = structuredClone(effect.payload.projection);
                                effect.payload.projection = rebaseCalendarProjection(effect.payload.projection, effect.payload.previousProjection, task.calendar.baseline);
                                effect.payload.previousProjection = task.calendar.baseline;
                                effect.payload.currentProjection = toCalendarProjection(task) ?? undefined;
                                effect.payload.baseline = task.calendar.baseline;
                                effect.payload.etag = task.calendar.etag;
                                effect.payload.calendarOrigin = task.calendar.origin;
                                if (task.googleEventId === task.calendar.eventId) effect.payload.googleEventId = task.googleEventId;
                            }
                        } else {
                            effect.payload = { ...effect.payload, calendarId: task.calendar.calendarId,
                                canonicalIdentity: task.calendar.canonicalIdentity, generation: task.calendar.generation,
                                type: task.type, baseline: task.calendar.baseline, etag: task.calendar.etag, calendarOrigin: task.calendar.origin };
                        }
                    }
                }
                const result = await this.options.execute(effect, {
                    isCurrent: async () => active && await this.isCurrent(claimed, metadataClock) && active,
                });
                return { ...result, calendarMetadataClock: metadataClock };
            };
            return await Promise.race([deadline, execution()]);
        } catch (error) {
            throw Object.assign(error && typeof error === 'object' ? error : new Error('Google effect failed'), { calendarMetadataClock: metadataClock });
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
        return this.db.transaction('rw', [this.db.agentProtocolEffects, this.db.agentCommandReceipts, this.db.tasks, this.db.settings], async () => {
            const effect = await this.db.agentProtocolEffects.get(id);
            if (!effect || !isDue(effect, this.now()) || !this.sessionMatches(effect)) return;
            if (this.options.canDeliver && !await this.options.canDeliver(effect)) return;
            if (effect.kind === 'calendar') {
                const task = await this.db.tasks.where('publicId').equals(effect.entityPublicId).first();
                if (calendarEffectMatchesTask(effect, task) && (task?.calendar?.conflict || task?.calendar?.readonlyReason)) return;
                if (calendarEffectMatchesTask(effect, task) && effect.operation === 'upsert' && !effect.payload.projection && task?.calendar && !task.calendar.baseline
                    && (await readCalendarSyncSettings(this.db, task.calendar.accountId))?.enabled
                    && !(this.options.canDeliver && isUnacknowledgedCalendarCreate(effect, task))) return;
            }
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

    private async isCurrent(claimed: AgentProtocolEffectRow, metadataClock?: number) {
        if (!this.owns(await this.db.agentProtocolEffects.get(claimed.id), claimed) || !this.sessionMatches(claimed)
            || (this.options.canDeliver && !await this.options.canDeliver(claimed))) return false;
        if (claimed.kind !== 'calendar') return true;
        const task = await this.db.tasks.where('publicId').equals(claimed.entityPublicId).first();
        return calendarEffectMatchesTask(claimed, task) && !task?.calendar?.conflict
            && (metadataClock === undefined || task?.calendar?.metadataUpdatedAt === metadataClock);
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
        return this.db.transaction('rw', taskMutationTables(this.db), async () => {
            const current = await this.db.agentProtocolEffects.get(claimed.id);
            if (!this.owns(current, claimed) || !this.sessionMatches(claimed)
                || (this.options.canDeliver && !await this.options.canDeliver(claimed))) return false;
            if (current.kind === 'calendar' && !execution.superseded) {
                const task = await this.db.tasks.where('publicId').equals(current.entityPublicId).first();
                if (!calendarEffectMatchesTask(current, task) || task?.calendar?.conflict
                    || (execution.calendarMetadataClock !== undefined && task?.calendar?.metadataUpdatedAt !== execution.calendarMetadataClock)) {
                    throw new Error('Calendar metadata changed before acknowledgement');
                }
                const expectedTarget = current.operation === 'upsert' ? current.payload.googleEventId ?? current.payload.reservedEventId : current.payload.eventId;
                if (current.operation === 'upsert' && execution.externalId !== expectedTarget) throw new Error('Calendar returned an unexpected event identity');
                if (current.operation === 'upsert' && current.payload.projection && !execution.calendar) throw new Error('Calendar acknowledgement missing projection');
                if (execution.calendar) {
                    if (execution.externalId !== expectedTarget || !calendarScopeMatches(task, execution.calendar)) throw new Error('Calendar acknowledgement scope mismatch');
                    await applyTaskEffectMetadata(this.db, current.entityPublicId, expectedTarget, expectedTarget, execution.calendar);
                } else if (current.operation === 'upsert') {
                    await applyTaskEffectMetadata(this.db, current.entityPublicId, execution.externalId, expectedTarget);
                }
            }
            const completed: AgentProtocolEffectRow = { ...current, state: execution.superseded ? 'failed' : 'succeeded',
                ...(execution.superseded ? { superseded: true } : {}), leaseOwner: undefined,
                leaseExpiresAt: undefined, nextAttemptAt: undefined, lastErrorCode: execution.superseded ? 'external_effect_failed' : undefined,
                lastErrorMessage: execution.superseded ? 'Původní Calendar záměr byl nahrazen novější změnou; nebyl odeslán.' : undefined,
                updatedAt: this.now() };
            await this.db.agentProtocolEffects.put(completed);
            await this.queueCommandResult(completed);
            return true;
        });
    }

    private async fail(claimed: AgentProtocolEffectRow, error: unknown) {
        return this.db.transaction('rw', [this.db.agentProtocolEffects, this.db.agentCommandReceipts,
            this.db.agentProtocolOutbox, this.db.tasks], async () => {
            const current = await this.db.agentProtocolEffects.get(claimed.id);
            if (!this.owns(current, claimed)) return 'fence_lost';
            const conflict = (error as { calendarConflict?: CalendarConflict } | null)?.calendarConflict;
            if (current.kind === 'calendar' && conflict && this.sessionMatches(current)) {
                const task = await this.db.tasks.where('publicId').equals(current.entityPublicId).first();
                const metadataClock = (error as { calendarMetadataClock?: number }).calendarMetadataClock;
                if (task?.calendar && calendarEffectMatchesTask(current, task)
                    && (metadataClock === undefined || task.calendar.metadataUpdatedAt === metadataClock)) {
                    await this.db.tasks.put({ ...task, calendar: { ...task.calendar, conflict,
                        metadataUpdatedAt: Math.max(this.now(), task.calendar.metadataUpdatedAt + 1) } });
                    const waiting: AgentProtocolEffectRow = { ...current, state: 'pending', leaseOwner: undefined, leaseExpiresAt: undefined,
                        nextAttemptAt: undefined, lastErrorCode: undefined, lastErrorMessage: 'Calendar změny čekají na výběr uživatele.', updatedAt: this.now() };
                    await this.db.agentProtocolEffects.put(waiting);
                    await this.queueCommandResult(waiting, false);
                    return 'pending';
                }
            }
            const status = (error as { status?: number } | null)?.status;
            const terminal = (error as { code?: string } | null)?.code === 'calendar_identity_mismatch'
                || (status !== undefined && status >= 400 && status < 500 && ![401, 403, 408, 409, 412, 429].includes(status));
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

    /** Protocol has no cancelled enum. Obsolete intents are inspectable failures,
     * explicitly labelled superseded; this never claims an external write succeeded. */
    async supersedeCalendarEffects(publicId: string, accountId: string): Promise<void> {
        await this.db.transaction('rw', taskMutationTables(this.db), async () => {
            const effects = await this.db.agentProtocolEffects.where('entityPublicId').equals(publicId).toArray();
            for (const effect of effects) {
                if (effect.kind !== 'calendar' || effect.accountId !== accountId || !isActive(effect)) continue;
                const retired: AgentProtocolEffectRow = { ...effect, state: 'failed', superseded: true, fencingToken: effect.fencingToken + 1,
                    leaseOwner: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined,
                    lastErrorCode: 'external_effect_failed',
                    lastErrorMessage: 'Původní záměr byl nahrazen výslovnou volbou při řešení konfliktu; nebyl odeslán.', updatedAt: this.now() };
                await this.db.agentProtocolEffects.put(retired);
                await this.queueCommandResult(retired);
            }
        });
    }
}

type GoogleEffectClient = Pick<GoogleService, 'addToCalendar' | 'deleteFromCalendar' | 'updateGoogleTask'>
    & Partial<Pick<GoogleService, 'writeCalendarEffect'>>;
export async function executeGoogleExternalEffect(client: GoogleEffectClient, effect: AgentProtocolEffectRow,
    guard: CalendarWriteGuard): Promise<ExternalEffectExecutionResult> {
    if (!await guard.isCurrent()) throw new Error('External effect ownership unavailable');
    if (effect.kind === 'calendar' && effect.operation === 'upsert') {
        if (effect.payload.projection) {
            const payload = effect.payload;
            if (!client.writeCalendarEffect || !effect.accountId || !payload.canonicalIdentity
                || (payload.type !== 'task' && payload.type !== 'meeting')
                || !calendarProjectionToTaskSchedule(payload.projection!, payload.type)) throw Object.assign(new Error('Invalid Calendar intent'), { status: 400 });
            return client.writeCalendarEffect({ ...payload, operation: 'upsert', type: payload.type,
                projection: payload.projection, accountId: effect.accountId, calendarId: payload.calendarId ?? 'primary',
                canonicalIdentity: payload.canonicalIdentity, generation: payload.generation ?? 0,
                eventId: payload.googleEventId ?? payload.reservedEventId, knownEvent: Boolean(payload.googleEventId), origin: payload.calendarOrigin,
                createMutationId: effect.mutationId }, guard);
        }
        const externalId = await client.addToCalendar({ ...effect.payload, reservedGoogleEventId: effect.payload.reservedEventId }, guard);
        if (!externalId) throw new Error('Google Calendar unavailable');
        return { externalId };
    }
    if (effect.kind === 'calendar' && effect.operation === 'delete') {
        const payload = effect.payload;
        if (payload.canonicalIdentity) {
            if (!client.writeCalendarEffect || !effect.accountId || (payload.type !== 'task' && payload.type !== 'meeting')) throw new Error('Invalid Calendar deletion intent');
            return client.writeCalendarEffect({ ...payload, operation: 'delete', type: payload.type, accountId: effect.accountId,
                calendarId: payload.calendarId ?? 'primary', canonicalIdentity: payload.canonicalIdentity,
                generation: payload.generation ?? 0, knownEvent: true, origin: payload.calendarOrigin }, guard);
        }
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
    const authKey = googleService.getAuthStatus().accessToken;
    return new ExternalEffectOutbox(defaultDb, {
        accountId: () => googleService.getAccountId(),
        canExecute: () => (typeof navigator === 'undefined' || navigator.onLine !== false)
            && googleService.getAuthStatus().accessToken === authKey && hasUsableAuth(googleService.getAuthStatus()),
        canDeliver: effect => calendarEffectDeliveryAllowed(defaultDb, effect, googleService.getAccountId(), authKey),
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
    const failed = effects.filter((effect) => effect.state === 'failed' && !effect.superseded
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
