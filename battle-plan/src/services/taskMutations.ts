import {
    db as defaultDb,
    type AgentProtocolEffectRow,
    type AgentProtocolEventRow,
    type BattlePlanDB,
    type Task,
} from '../db.ts';
import type { ProtocolRevision } from './agentProtocol/contracts.ts';
import {
    type AgentProtocolLedger,
    type CommandClaimToken,
    type PendingEffectInput,
    type PendingEventInput,
} from './agentProtocol/ledger.ts';
import {
    calculateProtocolRevisionId,
    validateEventBatchPayloadContract,
} from './agentProtocol/validation.ts';

export const TASK_EVENT_STREAM_ID = 'battleplan-events';
export const TASK_EVENT_PRODUCER_ID = 'battleplan-producer';

const UUID = /^(?:[Uu][Rr][Nn]:[Uu][Uu][Ii][Dd]:)?[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/;
const IDENTITY = /^[a-z][a-z0-9._:-]{2,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export type TaskMutationOrigin = AgentProtocolEventRow['origin'];

export interface TaskMutationContext {
    actor: string;
    origin: TaskMutationOrigin;
    causeId: string;
    mutationId?: string;
}

export type TaskDraft = Omit<Task, 'createdAt' | 'updatedAt' | 'protocolRevision'> & {
    createdAt?: number;
    updatedAt?: number;
};

export type TaskEffectRequest =
    | { kind: 'calendar'; operation: 'upsert' | 'delete' }
    | { kind: 'google_tasks'; operation: 'complete' };

export function calendarEffectsForLocalTask(
    task: Pick<Task, 'googleEventId' | 'type'>,
    operation: 'upsert' | 'delete',
    allowUnlinkedUpsert = false,
): TaskEffectRequest[] {
    const isLinked = Boolean(task.googleEventId);
    if (operation === 'delete') return isLinked ? [{ kind: 'calendar', operation }] : [];
    return isLinked || (task.type === 'meeting' && allowUnlinkedUpsert)
        ? [{ kind: 'calendar', operation }]
        : [];
}

export type TaskMutationApplied = {
    status: 'applied';
    task: Task;
    revision: ProtocolRevision;
    effectIds: string[];
};

export type TaskMutationResult = TaskMutationApplied
    | { status: 'stale'; currentRevision: string | null }
    | { status: 'not_found' }
    | { status: 'unchanged'; task: Task }
    | { status: 'expired' | 'fence_lost' };

export interface TaskMutationCommandContext {
    ledger: AgentProtocolLedger;
    claim: CommandClaimToken;
}

interface TaskMutationServiceOptions {
    now?: () => number;
    uuid?: () => string;
    beforeCommit?: () => void | Promise<void>;
}

interface ExistingTaskReference {
    publicId?: string;
    localId?: number;
    expectedRevision?: string;
}

interface MutationPlan {
    operation: 'create' | 'update' | 'complete' | 'archive' | 'import';
    eventType: AgentProtocolEventRow['eventType'];
    current?: Task;
    task: Task;
    context: Required<Pick<TaskMutationContext, 'actor' | 'origin' | 'causeId'>> & { mutationId: string };
    revision: ProtocolRevision;
    projection: Record<string, unknown>;
    effects: AgentProtocolEffectRow[];
}

function snapshotCommandContext(
    command: TaskMutationCommandContext | undefined,
): TaskMutationCommandContext | undefined {
    return command
        ? { ledger: command.ledger, claim: structuredClone(command.claim) }
        : undefined;
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** Normative Task projection: useful work state only, never local IDs, raw transcript, secrets, or pairing metadata. */
export function projectTaskForProtocol(task: Task): Record<string, unknown> {
    return withoutUndefined({
        title: task.title,
        description: task.description,
        type: task.type,
        duration: task.duration,
        totalDuration: task.totalDuration,
        date: task.date,
        deadline: task.deadline,
        startTime: task.startTime,
        isAllDay: task.isAllDay,
        urgency: task.urgency,
        status: task.status,
        subTasks: task.subTasks ? structuredClone(task.subTasks) : undefined,
        progress: task.progress,
        isDeleted: task.isDeleted === true ? true : undefined,
    });
}

function validateContext(context: TaskMutationContext): MutationPlan['context'] {
    const mutationId = context.mutationId ?? context.causeId;
    if (!IDENTITY.test(context.actor) || !UUID.test(context.causeId) || !UUID.test(mutationId)) {
        throw new TypeError('Invalid Task mutation context');
    }
    return { ...context, mutationId };
}

function currentRevision(task: Task | undefined): ProtocolRevision['revision_id'] | null {
    return task?.protocolRevision?.revision_id ?? null;
}

function isStale(task: Task | undefined, expectedRevision: string | undefined): boolean {
    if (expectedRevision == null) return false;
    if (!SHA256.test(expectedRevision)) throw new TypeError('Invalid expected Task revision');
    return currentRevision(task) !== expectedRevision;
}

function createPublicId(uuid: () => string): string {
    return `task_${uuid()}`;
}

function copyTaskFields(task: TaskDraft | Partial<Task>): Partial<Task> {
    const copy = structuredClone(task) as Partial<Task>;
    delete copy.id;
    delete copy.publicId;
    delete copy.protocolRevision;
    delete copy.createdAt;
    delete copy.updatedAt;
    return copy;
}

function effectRows(
    task: Task,
    context: MutationPlan['context'],
    requests: readonly TaskEffectRequest[],
    now: number,
    uuid: () => string,
): AgentProtocolEffectRow[] {
    return requests.flatMap((request): AgentProtocolEffectRow[] => {
        const base = {
            id: uuid(),
            entityKind: 'task' as const,
            entityPublicId: task.publicId!,
            mutationId: context.mutationId,
            state: 'pending' as const,
            attempts: 0,
            fencingToken: 0,
            createdAt: now,
            updatedAt: now,
        };
        if (request.kind === 'calendar' && request.operation === 'upsert') {
            const reservedEventId = `bp${base.id.replace(/^urn:uuid:/i, '').replaceAll('-', '')}`;
            const payload: Extract<AgentProtocolEffectRow, { kind: 'calendar'; operation: 'upsert' }>['payload'] = {
                title: task.title,
                reservedEventId,
                ...(task.description !== undefined ? { description: task.description } : {}),
                ...(task.date !== undefined ? { date: task.date } : {}),
                ...(task.deadline !== undefined ? { deadline: task.deadline } : {}),
                ...(task.startTime !== undefined ? { startTime: task.startTime } : {}),
                ...(task.duration !== undefined ? { duration: task.duration } : {}),
                ...(task.isAllDay !== undefined ? { isAllDay: task.isAllDay } : {}),
                ...(task.googleEventId !== undefined ? { googleEventId: task.googleEventId } : {}),
            };
            return [{
                ...base,
                kind: 'calendar',
                operation: 'upsert',
                payload,
            }];
        }
        if (request.kind === 'calendar' && request.operation === 'delete' && task.googleEventId) {
            return [{ ...base, kind: 'calendar', operation: 'delete', payload: { eventId: task.googleEventId } }];
        }
        if (request.kind === 'google_tasks' && task.googleId) {
            return [{
                ...base,
                kind: 'google_tasks',
                operation: 'complete',
                payload: withoutUndefined({ googleTaskId: task.googleId, googleListId: task.googleListId }) as { googleTaskId: string; googleListId?: string },
            }];
        }
        return [];
    });
}

function matchesEffectRequest(effect: AgentProtocolEffectRow, request: TaskEffectRequest): boolean {
    return effect.kind === request.kind && effect.operation === request.operation;
}

export class TaskMutationService {
    private readonly db: BattlePlanDB;
    private readonly options: TaskMutationServiceOptions;
    private readonly readNow: () => number;
    private readonly createUuid: () => string;

    constructor(
        db: BattlePlanDB,
        options: TaskMutationServiceOptions = {},
    ) {
        this.db = db;
        this.options = options;
        this.readNow = options.now ?? Date.now;
        this.createUuid = options.uuid ?? (() => crypto.randomUUID());
    }

    async createTask(input: {
        task: TaskDraft;
        context: TaskMutationContext;
        effects?: TaskEffectRequest[];
        command?: TaskMutationCommandContext;
    }): Promise<TaskMutationResult> {
        const request = {
            task: structuredClone(input.task),
            context: structuredClone(input.context),
            effects: structuredClone(input.effects ?? []),
            command: snapshotCommandContext(input.command),
        };
        const now = this.readNow();
        const publicId = request.task.publicId ?? createPublicId(this.createUuid);
        const task: Task = {
            ...copyTaskFields(request.task),
            title: request.task.title,
            type: request.task.type,
            urgency: request.task.urgency,
            status: request.task.status,
            publicId,
            createdAt: now,
            updatedAt: now,
        };
        const plan = this.plan('create', undefined, task, request.context, request.effects, now);
        return this.commit(plan, request.command);
    }

    async updateTask(input: ExistingTaskReference & {
        changes: Partial<Task>;
        context: TaskMutationContext;
        effects?: TaskEffectRequest[];
        command?: TaskMutationCommandContext;
    }): Promise<TaskMutationResult> {
        const request = {
            publicId: input.publicId,
            localId: input.localId,
            expectedRevision: input.expectedRevision,
            changes: structuredClone(input.changes),
            context: structuredClone(input.context),
            effects: structuredClone(input.effects ?? []),
            command: snapshotCommandContext(input.command),
        };
        const existing = await this.findExisting(request);
        if (!existing) return request.command ? this.finalizeStale(request.command, null) : { status: 'not_found' };
        if (isStale(existing, request.expectedRevision)) {
            return request.command
                ? this.finalizeStale(request.command, currentRevision(existing))
                : { status: 'stale', currentRevision: currentRevision(existing) };
        }
        const now = this.readNow();
        const task = {
            ...existing,
            ...copyTaskFields(request.changes),
            id: existing.id,
            publicId: existing.publicId,
            protocolRevision: existing.protocolRevision,
            createdAt: existing.createdAt,
            updatedAt: now,
        };
        return this.commit(this.plan('update', existing, task, request.context, request.effects, now), request.command);
    }

    async completeTask(input: ExistingTaskReference & {
        context: TaskMutationContext;
        effects?: TaskEffectRequest[];
        command?: TaskMutationCommandContext;
        changes?: Partial<Task>;
    }): Promise<TaskMutationResult> {
        return this.updateAs('complete', input, { ...input.changes, status: 'completed' });
    }

    async archiveTask(input: ExistingTaskReference & {
        context: TaskMutationContext;
        effects?: TaskEffectRequest[];
        command?: TaskMutationCommandContext;
        changes?: Partial<Task>;
    }): Promise<TaskMutationResult> {
        return this.updateAs('archive', input, { ...input.changes, isDeleted: true });
    }

    async importTask(input: { task: Task; context: TaskMutationContext }): Promise<TaskMutationResult> {
        const request = { task: structuredClone(input.task), context: structuredClone(input.context) };
        const [portableMatch, numericMatch] = await Promise.all([
            request.task.publicId ? this.db.tasks.where('publicId').equals(request.task.publicId).first() : undefined,
            request.task.id != null ? this.db.tasks.get(request.task.id) : undefined,
        ]);
        const existing = portableMatch ?? (request.task.publicId ? undefined : numericMatch);
        const remoteUpdated = request.task.updatedAt || request.task.createdAt || 0;
        const localUpdated = existing ? (existing.updatedAt || existing.createdAt || 0) : -1;
        if (existing && remoteUpdated <= localUpdated) return { status: 'unchanged', task: existing };
        const now = this.readNow();
        const task: Task = {
            ...copyTaskFields(request.task),
            id: existing?.id ?? (numericMatch ? undefined : request.task.id),
            publicId: existing?.publicId ?? request.task.publicId ?? createPublicId(this.createUuid),
            title: request.task.title,
            type: request.task.type,
            urgency: request.task.urgency,
            status: request.task.status,
            createdAt: existing?.createdAt ?? request.task.createdAt ?? now,
            updatedAt: remoteUpdated || now,
        };
        return this.commit(this.plan('import', existing, task, request.context, [], now));
    }

    async queueEffects(input: ExistingTaskReference & {
        context: TaskMutationContext;
        effects: TaskEffectRequest[];
    }): Promise<{ status: 'queued'; effectIds: string[] } | { status: 'not_found' }> {
        const request = {
            publicId: input.publicId,
            localId: input.localId,
            expectedRevision: input.expectedRevision,
            context: structuredClone(input.context),
            effects: structuredClone(input.effects),
        };
        const context = validateContext(request.context);
        return this.db.transaction('rw', [this.db.tasks, this.db.agentProtocolEffects], async () => {
            const task = await this.findExisting(request);
            if (!task) return { status: 'not_found' } as const;
            const active = await this.db.agentProtocolEffects
                .where('state')
                .anyOf(['pending', 'retry_scheduled', 'running'])
                .toArray();
            const effectIds: string[] = [];
            const additions: AgentProtocolEffectRow[] = [];
            for (const effectRequest of request.effects) {
                const existing = active.find((effect) => effect.entityPublicId === task.publicId && matchesEffectRequest(effect, effectRequest));
                if (existing) {
                    effectIds.push(existing.id);
                    continue;
                }
                const created = effectRows(task, context, [effectRequest], this.readNow(), this.createUuid);
                additions.push(...created);
                active.push(...created);
                effectIds.push(...created.map((effect) => effect.id));
            }
            if (additions.length) await this.db.agentProtocolEffects.bulkAdd(additions);
            return { status: 'queued', effectIds } as const;
        });
    }

    private async updateAs(
        operation: 'complete' | 'archive',
        input: ExistingTaskReference & {
            context: TaskMutationContext;
            effects?: TaskEffectRequest[];
            command?: TaskMutationCommandContext;
        },
        changes: Partial<Task>,
    ): Promise<TaskMutationResult> {
        const request = {
            publicId: input.publicId,
            localId: input.localId,
            expectedRevision: input.expectedRevision,
            context: structuredClone(input.context),
            effects: structuredClone(input.effects ?? []),
            command: snapshotCommandContext(input.command),
        };
        const safeChanges = structuredClone(changes);
        const existing = await this.findExisting(request);
        if (!existing) return request.command ? this.finalizeStale(request.command, null) : { status: 'not_found' };
        if (isStale(existing, request.expectedRevision)) {
            return request.command
                ? this.finalizeStale(request.command, currentRevision(existing))
                : { status: 'stale', currentRevision: currentRevision(existing) };
        }
        const now = this.readNow();
        const task = {
            ...existing,
            ...copyTaskFields(safeChanges),
            id: existing.id,
            publicId: existing.publicId,
            protocolRevision: existing.protocolRevision,
            createdAt: existing.createdAt,
            updatedAt: now,
        };
        return this.commit(this.plan(operation, existing, task, request.context, request.effects, now), request.command);
    }

    private async findExisting(reference: ExistingTaskReference): Promise<Task | undefined> {
        if (reference.publicId) return this.db.tasks.where('publicId').equals(reference.publicId).first();
        if (reference.localId != null) return this.db.tasks.get(reference.localId);
        return undefined;
    }

    private plan(
        operation: MutationPlan['operation'],
        existing: Task | undefined,
        next: Task,
        rawContext: TaskMutationContext,
        requestedEffects: readonly TaskEffectRequest[],
        now: number,
    ): MutationPlan {
        const context = validateContext(rawContext);
        const projection = projectTaskForProtocol(next);
        const baseRevision = currentRevision(existing);
        const revision: ProtocolRevision = {
            revision_id: calculateProtocolRevisionId({
                entity_kind: 'task',
                entity_public_id: next.publicId!,
                base_revision: baseRevision,
                mutation_id: context.mutationId,
                projection,
                tombstone: operation === 'archive',
            }),
            base_revision: baseRevision,
            mutation_id: context.mutationId,
        };
        const task = { ...next, protocolRevision: revision };
        return {
            operation,
            eventType: existing ? (operation === 'archive' ? 'entity_deleted' : 'entity_updated') : 'entity_created',
            current: existing,
            task,
            context,
            revision,
            projection,
            effects: effectRows(task, context, requestedEffects, now, this.createUuid),
        };
    }

    private pendingEvent(plan: MutationPlan): PendingEventInput {
        return {
            eventId: this.createUuid(),
            streamId: TASK_EVENT_STREAM_ID,
            producerId: TASK_EVENT_PRODUCER_ID,
            eventType: plan.eventType,
            entityKind: 'task',
            entityPublicId: plan.task.publicId!,
            revision: plan.revision,
            payloadDigest: plan.revision.revision_id,
            occurredAt: new Date(this.readNow()).toISOString(),
            actor: plan.context.actor,
            origin: plan.context.origin,
            causeId: plan.context.causeId,
            projection: plan.projection,
        };
    }

    private pendingEffects(plan: MutationPlan): PendingEffectInput[] {
        return plan.effects.map((effect): PendingEffectInput => {
            const identity = {
                id: effect.id,
                entityKind: effect.entityKind,
                entityPublicId: effect.entityPublicId,
                mutationId: effect.mutationId,
            };
            if (effect.kind === 'calendar' && effect.operation === 'upsert') {
                return { ...identity, kind: 'calendar', operation: 'upsert', payload: structuredClone(effect.payload) };
            }
            if (effect.kind === 'calendar' && effect.operation === 'delete') {
                return { ...identity, kind: 'calendar', operation: 'delete', payload: structuredClone(effect.payload) };
            }
            return { ...identity, kind: 'google_tasks', operation: 'complete', payload: structuredClone(effect.payload) };
        });
    }

    private async assertPlanStillCurrent(plan: MutationPlan): Promise<Task | undefined> {
        const current = plan.current?.id != null ? await this.db.tasks.get(plan.current.id) : undefined;
        if (plan.current && currentRevision(current) !== currentRevision(plan.current)) {
            throw new Error('task_revision_changed_during_mutation');
        }
        if (!plan.current && await this.db.tasks.where('publicId').equals(plan.task.publicId!).count()) {
            throw new Error('task_public_id_conflict');
        }
        return current;
    }

    private async persistPlanTask(plan: MutationPlan): Promise<Task> {
        const current = await this.assertPlanStillCurrent(plan);
        const task = structuredClone(plan.task);
        if (plan.current && current) {
            for (const field of ['googleEventId', 'googleId', 'googleListId'] as const) {
                if (current[field] !== plan.current[field]) task[field] = current[field];
            }
        }
        const id = await this.db.tasks.put(task);
        await this.options.beforeCommit?.();
        return { ...task, id };
    }

    private async commit(
        plan: MutationPlan,
        command?: TaskMutationCommandContext,
    ): Promise<TaskMutationResult> {
        if (command) return this.commitCommand(plan, command);
        return this.db.transaction('rw', [
            this.db.tasks,
            this.db.agentEventStreams,
            this.db.agentProtocolEvents,
            this.db.agentProtocolOutbox,
            this.db.agentProtocolEffects,
        ], async () => {
            const stream = await this.db.agentEventStreams.get(TASK_EVENT_STREAM_ID);
            if (stream && stream.producerId !== TASK_EVENT_PRODUCER_ID) throw new Error('event_stream_producer_conflict');
            const sequence = stream?.nextSequence ?? '1';
            const pendingEvent = this.pendingEvent(plan);
            const event: AgentProtocolEventRow = {
                id: `${TASK_EVENT_STREAM_ID}\0${sequence}`,
                eventId: pendingEvent.eventId,
                streamId: TASK_EVENT_STREAM_ID,
                producerId: TASK_EVENT_PRODUCER_ID,
                sequence,
                eventType: plan.eventType,
                entityKind: 'task',
                entityPublicId: plan.task.publicId!,
                revision: plan.revision,
                payloadDigest: plan.revision.revision_id,
                occurredAt: pendingEvent.occurredAt,
                actor: plan.context.actor,
                origin: plan.context.origin,
                causeId: plan.context.causeId,
                projection: plan.projection,
                createdAt: this.readNow(),
            };
            const payload = {
                stream_id: TASK_EVENT_STREAM_ID,
                sequence_from: sequence,
                sequence_to: sequence,
                events: [{
                    event_id: event.eventId,
                    sequence,
                    event_type: event.eventType,
                    entity_kind: event.entityKind,
                    entity_public_id: event.entityPublicId,
                    revision: event.revision,
                    occurred_at: event.occurredAt,
                    actor: event.actor,
                    origin: event.origin,
                    cause_id: event.causeId,
                    projection: event.projection,
                }],
            };
            if (!validateEventBatchPayloadContract(payload)) {
                throw new TypeError('Generated Task event violates the public protocol contract');
            }

            const stored = await this.persistPlanTask(plan);
            await this.db.agentEventStreams.put({
                streamId: TASK_EVENT_STREAM_ID,
                producerId: TASK_EVENT_PRODUCER_ID,
                nextSequence: (BigInt(sequence) + 1n).toString(),
                updatedAt: this.readNow(),
            });
            await this.db.agentProtocolEvents.add(event);
            await this.db.agentProtocolOutbox.add({
                id: `event-batch\0${TASK_EVENT_STREAM_ID}\0${sequence}`,
                family: 'event',
                messageId: this.createUuid(),
                payload,
                status: 'pending',
                attempts: 0,
                createdAt: this.readNow(),
                updatedAt: this.readNow(),
            });
            if (plan.effects.length) await this.db.agentProtocolEffects.bulkAdd(plan.effects);
            return { status: 'applied', task: stored, revision: plan.revision, effectIds: plan.effects.map((effect) => effect.id) };
        });
    }

    private async commitCommand(
        plan: MutationPlan,
        command: TaskMutationCommandContext,
    ): Promise<TaskMutationResult> {
        const protocolEffects = plan.effects.map((effect) => ({ effect_id: effect.id, kind: effect.kind, state: 'pending' as const }));
        const resultPayload = {
            command_id: command.claim.commandId,
            state: 'applied' as const,
            entity_public_id: plan.task.publicId!,
            revision: plan.revision,
            ...(protocolEffects.length ? { effects: protocolEffects } : {}),
        };
        try {
            const finalized = await command.ledger.commitFencedMutation({
                claim: command.claim,
                lifecycle: 'applied',
                result: { entityPublicId: plan.task.publicId, revision: plan.revision },
                outbox: [{
                    id: `result\0${command.claim.receiptId}\0${command.claim.fencingToken}`,
                    family: 'result',
                    messageId: this.createUuid(),
                    payload: resultPayload,
                }],
                events: [this.pendingEvent(plan)],
                effects: this.pendingEffects(plan),
            }, [this.db.tasks], async () => this.persistPlanTask(plan));
            if (finalized.status === 'fence_lost' || finalized.status === 'expired') return { status: finalized.status };
            return {
                status: 'applied',
                task: finalized.value!,
                revision: plan.revision,
                effectIds: plan.effects.map((effect) => effect.id),
            };
        } catch (error) {
            if (error instanceof Error && error.message === 'task_revision_changed_during_mutation') {
                const latest = plan.task.publicId
                    ? await this.db.tasks.where('publicId').equals(plan.task.publicId).first()
                    : undefined;
                return this.finalizeStale(command, currentRevision(latest));
            }
            throw error;
        }
    }

    private async finalizeStale(
        command: TaskMutationCommandContext,
        current: string | null,
    ): Promise<TaskMutationResult> {
        const finalized = await command.ledger.finalizeCommand({
            claim: command.claim,
            lifecycle: 'stale',
            errorCode: 'revision_stale',
            outbox: [{
                id: `result\0${command.claim.receiptId}\0${command.claim.fencingToken}`,
                family: 'result',
                messageId: this.createUuid(),
                payload: { command_id: command.claim.commandId, state: 'stale', error_code: 'revision_stale' },
            }],
        });
        return finalized.status === 'finalized'
            ? { status: 'stale', currentRevision: current }
            : { status: finalized.status };
    }
}

/** Integration bookkeeping called only from the effect outbox's success transaction. */
export async function applyTaskEffectMetadata(
    db: BattlePlanDB,
    entityPublicId: string,
    externalId: string | undefined,
): Promise<void> {
    if (!externalId) return;
    const task = await db.tasks.where('publicId').equals(entityPublicId).first();
    if (task?.id != null) await db.tasks.update(task.id, { googleEventId: externalId });
}

export function newTaskMutationContext(
    origin: TaskMutationOrigin,
    actor = origin === 'hermes' ? 'hermes-agent' : 'battleplan-user',
): TaskMutationContext {
    return { actor, origin, causeId: crypto.randomUUID() };
}

export const taskMutations = new TaskMutationService(defaultDb);
