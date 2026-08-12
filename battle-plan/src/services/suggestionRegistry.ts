import type {
    AgentProtocolOutboxRow,
    SuggestionDecisionKind,
    SuggestionDecisionRow,
    SuggestionOccurrenceRow,
    SuggestionSubjectRow,
    Task,
} from '../db.ts';
import { db, type BattlePlanDB } from '../db.ts';
import {
    deriveSuggestionIdentity,
    suggestionTitleSimilarity,
    type SuggestionIdentity,
} from '../utils/suggestionIdentity.ts';
import type { AgentSuggestion, AgentSuggestionReply } from './suggestionsSync.ts';
import type { ResponsePayload } from './agentProtocol/contracts.ts';

const TERMINAL_KINDS = new Set<SuggestionDecisionKind>([
    'accepted',
    'converted',
    'rejected',
    'dismissed',
]);
const STATE_KINDS = new Set<SuggestionDecisionKind>([
    ...TERMINAL_KINDS,
    'deferred',
    'reopened',
]);
const POSSIBLE_DUPLICATE_THRESHOLD = 0.55;
const PROTOCOL_UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface SuggestionResolution {
    state: 'open' | 'commented' | 'deferred' | 'processed' | 'possible-duplicate';
    identity: SuggestionIdentity;
    decision?: SuggestionDecisionRow;
    matchedOccurrenceKey?: string;
    matchedSuggestionId?: string;
    matchedTitle?: string;
    similarity?: number;
}

export type SuggestionDisplayStatus = AgentSuggestion['status'];

export function effectiveSuggestionStatus(
    suggestion: AgentSuggestion,
    resolution: SuggestionResolution | undefined,
): SuggestionDisplayStatus {
    if (
        resolution?.state === 'open'
        || resolution?.state === 'commented'
        || resolution?.state === 'possible-duplicate'
    ) return 'open';
    if (!resolution?.decision) return suggestion.status;
    if (resolution.state === 'deferred') return 'deferred';
    if (resolution.state !== 'processed') return 'open';
    switch (resolution.decision.kind) {
        case 'accepted': return 'accepted';
        case 'converted': return 'converted';
        case 'rejected':
        case 'dismissed': return 'rejected';
        default: return suggestion.status;
    }
}

export type SuggestionDecisionInput =
    | { kind: 'commented'; comment: string }
    | { kind: 'deferred'; deferUntil: number }
    | { kind: 'accepted' | 'rejected' | 'dismissed' | 'reopened' };

export type SuggestionTaskDraft = Omit<
    Task,
    'id' | 'publicId' | 'suggestionSubjectId' | 'suggestionOccurrenceKey'
>;

export type SuggestionConversionResult =
    | { outcome: 'created'; task: Task; decision: SuggestionDecisionRow }
    | { outcome: 'existing'; task: Task; decision: SuggestionDecisionRow };

export interface SuggestionRegistrySnapshot {
    version: 1;
    last_updated: number;
    subjects: SuggestionSubjectRow[];
    occurrences: SuggestionOccurrenceRow[];
    decisions: SuggestionDecisionRow[];
}

export class SuggestionAlreadyProcessedError extends Error {
    readonly decision: SuggestionDecisionRow;

    constructor(decision: SuggestionDecisionRow) {
        super(`suggestion already processed as ${decision.kind}`);
        this.name = 'SuggestionAlreadyProcessedError';
        this.decision = decision;
    }
}

export class SuggestionRegistryConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SuggestionRegistryConflictError';
    }
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function byNewest(left: SuggestionDecisionRow, right: SuggestionDecisionRow): number {
    return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}

function effectiveStateDecision(
    decisions: readonly SuggestionDecisionRow[],
): SuggestionDecisionRow | undefined {
    return decisions.find((decision) => TERMINAL_KINDS.has(decision.kind))
        ?? decisions.find((decision) => STATE_KINDS.has(decision.kind));
}

function immutableDecisionPayload(decision: SuggestionDecisionRow): string {
    return JSON.stringify({
        subjectId: decision.subjectId,
        occurrenceKey: decision.occurrenceKey,
        suggestionId: decision.suggestionId,
        kind: decision.kind,
        comment: decision.comment,
        deferUntil: decision.deferUntil,
        taskPublicId: decision.taskPublicId,
        createdAt: decision.createdAt,
    });
}

function mergeSubject(
    local: SuggestionSubjectRow | undefined,
    incoming: SuggestionSubjectRow,
): SuggestionSubjectRow {
    if (!local) return incoming;
    const newer = incoming.updatedAt > local.updatedAt ? incoming : local;
    return {
        ...newer,
        id: local.id,
        aliases: unique([...local.aliases, ...incoming.aliases]),
        distinctFromSubjectIds: unique([
            ...local.distinctFromSubjectIds,
            ...incoming.distinctFromSubjectIds,
        ]),
        createdAt: Math.min(local.createdAt, incoming.createdAt),
        updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    };
}

function mergeOccurrence(
    local: SuggestionOccurrenceRow | undefined,
    incoming: SuggestionOccurrenceRow,
): SuggestionOccurrenceRow {
    if (!local) return incoming;
    if (local.subjectId !== incoming.subjectId) {
        throw new SuggestionRegistryConflictError(
            `occurrence ${incoming.id} points to two different subjects`,
        );
    }
    const newer = incoming.updatedAt > local.updatedAt ? incoming : local;
    return {
        ...newer,
        id: local.id,
        subjectId: local.subjectId,
        aliases: unique([...local.aliases, ...incoming.aliases]),
        proposalIds: unique([...local.proposalIds, ...incoming.proposalIds]),
        sourceScope: unique([...local.sourceScope, ...incoming.sourceScope]),
        createdAt: Math.min(local.createdAt, incoming.createdAt),
        updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    };
}

function parseTaskId(content: string): number | undefined {
    const match = content.match(/task\s*#(\d+)/i);
    return match ? Number(match[1]) : undefined;
}

function parseDeferUntil(reply: AgentSuggestionReply): number | undefined {
    const value = reply.action_data?.defer_until;
    if (!value) return undefined;
    const parsed = Date.parse(`${value}T00:00:00`);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function statusDecisionKind(status: AgentSuggestion['status']): SuggestionDecisionKind | null {
    switch (status) {
        case 'accepted': return 'accepted';
        case 'converted': return 'converted';
        case 'rejected': return 'rejected';
        case 'deferred': return 'deferred';
        default: return null;
    }
}

function replyDecisionKind(reply: AgentSuggestionReply): SuggestionDecisionKind {
    switch (reply.action) {
        case 'accept': return reply.action_data?.convert_to_task ? 'converted' : 'accepted';
        case 'reject': return 'rejected';
        case 'defer': return 'deferred';
        default: return 'commented';
    }
}

function localDate(timestamp: number): string {
    const value = new Date(timestamp);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function protocolResponseOutbox(
    suggestion: AgentSuggestion,
    decision: SuggestionDecisionRow,
    now: number,
): AgentProtocolOutboxRow | null {
    const subjectId = suggestion.subject_id?.trim();
    const occurrenceKey = suggestion.occurrence_key?.trim();
    if (!PROTOCOL_UUID.test(suggestion.id) || !subjectId || !occurrenceKey) return null;
    const protocolDecision: ResponsePayload['decision'] | null = (() => {
        switch (decision.kind) {
            case 'commented': return 'commented';
            case 'accepted': return 'accepted';
            case 'converted': return 'converted_to_task';
            case 'rejected':
            case 'dismissed': return 'rejected';
            default: return decision.kind === 'deferred' ? 'deferred' : null;
        }
    })();
    if (!protocolDecision) return null;
    const payload: ResponsePayload = {
        proposal_id: suggestion.id,
        subject_id: subjectId,
        occurrence_key: occurrenceKey,
        decision: protocolDecision,
        ...(decision.deferUntil != null ? { defer_until: localDate(decision.deferUntil) } : {}),
        ...(decision.comment ? { comment: decision.comment } : {}),
        ...(decision.taskPublicId ? { task_public_id: decision.taskPublicId } : {}),
    };
    return {
        id: `suggestion-response:${decision.id}`,
        family: 'response',
        messageId: crypto.randomUUID(),
        payload,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
    };
}

export class SuggestionRegistry {
    private readonly database: BattlePlanDB;

    constructor(database: BattlePlanDB = db) {
        this.database = database;
    }

    private async findOccurrence(identity: SuggestionIdentity): Promise<SuggestionOccurrenceRow | undefined> {
        const direct = await this.database.suggestionOccurrences.get(identity.occurrenceKey);
        const aliasOwners = await this.database.suggestionOccurrences
            .filter((occurrence) => occurrence.aliases.includes(identity.occurrenceKey))
            .toArray();
        if (aliasOwners.length > 1) {
            throw new SuggestionRegistryConflictError(
                `occurrence alias ${identity.occurrenceKey} has multiple owners`,
            );
        }
        // An alias owner is a durable merge target and intentionally wins over
        // a retained historical occurrence with the same canonical key.
        return aliasOwners[0] ?? direct;
    }

    private async ensureIdentityRows(
        suggestion: AgentSuggestion,
        now = Date.now(),
    ): Promise<{ identity: SuggestionIdentity; subject: SuggestionSubjectRow; occurrence: SuggestionOccurrenceRow }> {
        const identity = deriveSuggestionIdentity(suggestion);
        let occurrence = await this.findOccurrence(identity);
        const existingSubject = occurrence
            ? await this.database.suggestionSubjects.get(occurrence.subjectId)
            : await this.database.suggestionSubjects.get(identity.subjectId);
        const subject: SuggestionSubjectRow = existingSubject ?? {
            id: identity.subjectId,
            canonicalFingerprint: identity.exactFingerprint,
            aliases: [],
            distinctFromSubjectIds: [],
            title: suggestion.title,
            category: suggestion.category,
            source: suggestion.source,
            createdAt: now,
            updatedAt: now,
        };
        const nextSubjectAliases = unique([
            ...subject.aliases,
            ...(identity.subjectId === subject.id ? [] : [identity.subjectId]),
        ]);
        const nextSubjectTitle = subject.title || suggestion.title;
        const subjectChanged = nextSubjectAliases.length !== subject.aliases.length
            || nextSubjectTitle !== subject.title;
        const nextSubject: SuggestionSubjectRow = {
            ...subject,
            aliases: nextSubjectAliases,
            title: nextSubjectTitle,
            updatedAt: subjectChanged ? Math.max(subject.updatedAt, now) : subject.updatedAt,
        };
        if (!existingSubject || subjectChanged) {
            await this.database.suggestionSubjects.put(nextSubject);
        }

        const existingOccurrence = occurrence;
        occurrence ??= {
            id: identity.occurrenceKey,
            subjectId: nextSubject.id,
            aliases: [],
            proposalIds: [],
            exactFingerprint: identity.exactFingerprint,
            titleSnapshot: suggestion.title,
            sourceScope: identity.sourceScope,
            createdAt: now,
            updatedAt: now,
        };
        const nextProposalIds = unique([...occurrence.proposalIds, suggestion.id]);
        const occurrenceChanged = nextProposalIds.length !== occurrence.proposalIds.length;
        const nextOccurrence: SuggestionOccurrenceRow = {
            ...occurrence,
            proposalIds: nextProposalIds,
            updatedAt: occurrenceChanged ? Math.max(occurrence.updatedAt, now) : occurrence.updatedAt,
        };
        if (!existingOccurrence || occurrenceChanged) {
            await this.database.suggestionOccurrences.put(nextOccurrence);
        }
        return { identity, subject: nextSubject, occurrence: nextOccurrence };
    }

    private async decisionsFor(occurrenceKey: string): Promise<SuggestionDecisionRow[]> {
        return (await this.database.suggestionDecisions
            .where('occurrenceKey')
            .equals(occurrenceKey)
            .toArray())
            .sort(byNewest);
    }

    private resolveFromDecisions(
        identity: SuggestionIdentity,
        occurrence: SuggestionOccurrenceRow,
        decisions: SuggestionDecisionRow[],
        now: number,
    ): SuggestionResolution | null {
        // A terminal decision is permanent. A later stale defer/reopen from
        // another device must never make an already processed occurrence live.
        const stateDecision = effectiveStateDecision(decisions);
        const comment = decisions.find((decision) => decision.kind === 'commented');
        const match = {
            identity,
            decision: stateDecision ?? comment,
            matchedOccurrenceKey: occurrence.id,
            matchedSuggestionId: occurrence.proposalIds[0],
            matchedTitle: occurrence.titleSnapshot,
        };

        if (stateDecision && TERMINAL_KINDS.has(stateDecision.kind)) {
            return { state: 'processed', ...match };
        }
        if (stateDecision?.kind === 'deferred'
            && stateDecision.deferUntil != null
            && now < stateDecision.deferUntil) {
            return { state: 'deferred', ...match };
        }
        if (comment) {
            return {
                state: 'commented',
                identity,
                decision: comment,
                matchedOccurrenceKey: occurrence.id,
                matchedSuggestionId: occurrence.proposalIds[0],
                matchedTitle: occurrence.titleSnapshot,
            };
        }
        return null;
    }

    async ingestLegacy(
        suggestions: readonly AgentSuggestion[],
        replies: readonly AgentSuggestionReply[],
    ): Promise<void> {
        const byId = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
        await this.database.transaction(
            'rw',
            this.database.suggestionSubjects,
            this.database.suggestionOccurrences,
            this.database.suggestionDecisions,
            this.database.agentProtocolOutbox,
            async () => {
                const existingDecisions = new Map(
                    (await this.database.suggestionDecisions.toArray())
                        .map((decision) => [decision.id, decision]),
                );
                const putLegacyDecision = async (decision: SuggestionDecisionRow) => {
                    const existing = existingDecisions.get(decision.id);
                    const next = {
                        ...decision,
                        ...(existing?.taskId != null && decision.taskId == null
                            ? { taskId: existing.taskId }
                            : {}),
                        ...(existing?.taskPublicId != null && decision.taskPublicId == null
                            ? { taskPublicId: existing.taskPublicId }
                            : {}),
                        ...(existing?.publishedAt != null
                            ? { publishedAt: existing.publishedAt }
                            : {}),
                    };
                    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return;
                    await this.database.suggestionDecisions.put(next);
                    existingDecisions.set(next.id, next);
                };
                for (const suggestion of suggestions) {
                    const { subject, occurrence } = await this.ensureIdentityRows(suggestion, suggestion.created_at);
                    const kind = statusDecisionKind(suggestion.status);
                    if (!kind) continue;
                    // The legacy status carries no resume date. A dated reply
                    // below is the only safe source of a time-bounded defer.
                    if (kind === 'deferred') continue;
                    const createdAt = suggestion.status_updated_at ?? suggestion.created_at;
                    await putLegacyDecision({
                        id: `legacy-status:${suggestion.id}:${kind}:${createdAt}`,
                        subjectId: subject.id,
                        occurrenceKey: occurrence.id,
                        suggestionId: suggestion.id,
                        kind,
                        createdAt,
                    });
                }

                for (const reply of replies) {
                    const suggestion = byId.get(reply.suggestion_id);
                    if (!suggestion) continue;
                    const { subject, occurrence } = await this.ensureIdentityRows(suggestion, reply.created_at);
                    const kind = replyDecisionKind(reply);
                    const deferUntil = kind === 'deferred' ? parseDeferUntil(reply) : undefined;
                    if (kind === 'deferred' && deferUntil == null) continue;
                    await putLegacyDecision({
                        id: `legacy-reply:${reply.id}`,
                        subjectId: subject.id,
                        occurrenceKey: occurrence.id,
                        suggestionId: suggestion.id,
                        kind,
                        ...(reply.content ? { comment: reply.content } : {}),
                        ...(deferUntil != null ? { deferUntil } : {}),
                        ...(kind === 'converted' ? { taskId: parseTaskId(reply.content) } : {}),
                        createdAt: reply.created_at,
                    });
                }
            },
        );
    }

    async exportSnapshot(now = Date.now()): Promise<SuggestionRegistrySnapshot> {
        const [subjects, occurrences, decisions] = await Promise.all([
            this.database.suggestionSubjects.toArray(),
            this.database.suggestionOccurrences.toArray(),
            this.database.suggestionDecisions.toArray(),
        ]);
        return {
            version: 1,
            last_updated: now,
            subjects,
            occurrences,
            decisions,
        };
    }

    async mergeSnapshot(snapshot: SuggestionRegistrySnapshot, now = Date.now()): Promise<void> {
        await this.database.transaction(
            'rw',
            this.database.suggestionSubjects,
            this.database.suggestionOccurrences,
            this.database.suggestionDecisions,
            async () => {
                for (const incoming of snapshot.subjects) {
                    const local = await this.database.suggestionSubjects.get(incoming.id);
                    await this.database.suggestionSubjects.put(mergeSubject(local, incoming));
                }
                for (const incoming of snapshot.occurrences) {
                    const subject = await this.database.suggestionSubjects.get(incoming.subjectId);
                    if (!subject) {
                        throw new SuggestionRegistryConflictError(
                            `occurrence ${incoming.id} references a missing subject`,
                        );
                    }
                    const local = await this.database.suggestionOccurrences.get(incoming.id);
                    await this.database.suggestionOccurrences.put(mergeOccurrence(local, incoming));
                }
                for (const incoming of snapshot.decisions) {
                    const occurrence = await this.database.suggestionOccurrences.get(incoming.occurrenceKey);
                    if (!occurrence || occurrence.subjectId !== incoming.subjectId) {
                        throw new SuggestionRegistryConflictError(
                            `decision ${incoming.id} references an invalid occurrence`,
                        );
                    }
                    const local = await this.database.suggestionDecisions.get(incoming.id);
                    if (local && immutableDecisionPayload(local) !== immutableDecisionPayload(incoming)) {
                        throw new SuggestionRegistryConflictError(
                            `decision ${incoming.id} has conflicting immutable data`,
                        );
                    }
                    await this.database.suggestionDecisions.put({
                        ...incoming,
                        ...(local?.taskId != null ? { taskId: local.taskId } : {}),
                        publishedAt: local?.publishedAt ?? incoming.publishedAt ?? now,
                    });
                }
            },
        );
    }

    async markPublished(decisionIds: readonly string[], publishedAt = Date.now()): Promise<void> {
        if (decisionIds.length === 0) return;
        await this.database.transaction('rw', this.database.suggestionDecisions, async () => {
            for (const id of decisionIds) {
                const decision = await this.database.suggestionDecisions.get(id);
                if (decision && decision.publishedAt == null) {
                    await this.database.suggestionDecisions.put({ ...decision, publishedAt });
                }
            }
        });
    }

    async resolveMany(
        suggestions: readonly AgentSuggestion[],
        now = Date.now(),
    ): Promise<SuggestionResolution[]> {
        const [subjects, occurrences, decisions] = await Promise.all([
            this.database.suggestionSubjects.toArray(),
            this.database.suggestionOccurrences.toArray(),
            this.database.suggestionDecisions.toArray(),
        ]);
        const subjectsById = new Map(subjects.map((subject) => [subject.id, subject]));
        const occurrencesById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
        const aliasOwners = new Map<string, SuggestionOccurrenceRow>();
        for (const occurrence of occurrences) {
            for (const alias of occurrence.aliases) {
                const owner = aliasOwners.get(alias);
                if (owner && owner.id !== occurrence.id) {
                    throw new SuggestionRegistryConflictError(`occurrence alias ${alias} has multiple owners`);
                }
                aliasOwners.set(alias, occurrence);
            }
        }
        const decisionsByOccurrence = new Map<string, SuggestionDecisionRow[]>();
        for (const decision of decisions) {
            const values = decisionsByOccurrence.get(decision.occurrenceKey) ?? [];
            values.push(decision);
            decisionsByOccurrence.set(decision.occurrenceKey, values);
        }
        for (const values of decisionsByOccurrence.values()) values.sort(byNewest);

        return suggestions.map((suggestion) => {
            const identity = deriveSuggestionIdentity(suggestion);
            const occurrence = aliasOwners.get(identity.occurrenceKey)
                ?? occurrencesById.get(identity.occurrenceKey);
            if (occurrence) {
                const resolution = this.resolveFromDecisions(
                    identity,
                    occurrence,
                    decisionsByOccurrence.get(occurrence.id) ?? [],
                    now,
                );
                if (resolution) return resolution;
            }

            const currentSubject = subjectsById.get(identity.subjectId);
            let best: SuggestionResolution | null = null;
            for (const candidate of occurrences) {
                if (candidate.id === identity.occurrenceKey
                    || candidate.aliases.includes(identity.occurrenceKey)) continue;
                const subject = subjectsById.get(candidate.subjectId);
                if (!subject || subject.category !== suggestion.category) continue;
                if (currentSubject && subject.id === currentSubject.id) continue;
                if (currentSubject?.distinctFromSubjectIds.includes(subject.id)) continue;
                const resolved = this.resolveFromDecisions(
                    identity,
                    candidate,
                    decisionsByOccurrence.get(candidate.id) ?? [],
                    now,
                );
                if (resolved?.state !== 'processed' && resolved?.state !== 'deferred') continue;
                const similarity = suggestionTitleSimilarity(suggestion.title, candidate.titleSnapshot);
                if (similarity < POSSIBLE_DUPLICATE_THRESHOLD || similarity <= (best?.similarity ?? 0)) continue;
                best = { ...resolved, state: 'possible-duplicate', similarity };
            }
            return best ?? { state: 'open', identity };
        });
    }

    async resolve(suggestion: AgentSuggestion, now = Date.now()): Promise<SuggestionResolution> {
        return (await this.resolveMany([suggestion], now))[0];
    }

    async recordDecision(
        suggestion: AgentSuggestion,
        input: SuggestionDecisionInput,
        now = Date.now(),
    ): Promise<SuggestionDecisionRow> {
        if ('deferUntil' in input && !Number.isFinite(input.deferUntil)) {
            throw new Error('deferUntil must be a finite timestamp');
        }
        return this.database.transaction(
            'rw',
            [
                this.database.suggestionSubjects,
                this.database.suggestionOccurrences,
                this.database.suggestionDecisions,
                this.database.agentProtocolOutbox,
            ],
            async () => {
                const { subject, occurrence } = await this.ensureIdentityRows(suggestion, now);
                const decision: SuggestionDecisionRow = {
                    id: `sdec_${crypto.randomUUID()}`,
                    subjectId: subject.id,
                    occurrenceKey: occurrence.id,
                    suggestionId: suggestion.id,
                    kind: input.kind,
                    ...('comment' in input ? { comment: input.comment } : {}),
                    ...('deferUntil' in input ? { deferUntil: input.deferUntil } : {}),
                    createdAt: now,
                };
                await this.database.suggestionDecisions.add(decision);
                const outbox = protocolResponseOutbox(suggestion, decision, now);
                if (outbox) await this.database.agentProtocolOutbox.add(outbox);
                return decision;
            },
        );
    }

    async convertToTask(
        suggestion: AgentSuggestion,
        draft: SuggestionTaskDraft,
        now = Date.now(),
    ): Promise<SuggestionConversionResult> {
        return this.database.transaction(
            'rw',
            [
                this.database.tasks,
                this.database.suggestionSubjects,
                this.database.suggestionOccurrences,
                this.database.suggestionDecisions,
                this.database.agentProtocolOutbox,
            ],
            async () => {
                const { subject, occurrence } = await this.ensureIdentityRows(suggestion, now);
                const decisions = await this.decisionsFor(occurrence.id);
                const stateDecision = effectiveStateDecision(decisions);
                const existingTask = await this.database.tasks
                    .where('suggestionOccurrenceKey')
                    .equals(occurrence.id)
                    .first();

                if (stateDecision && TERMINAL_KINDS.has(stateDecision.kind)) {
                    if ((stateDecision.kind === 'converted' || stateDecision.kind === 'accepted') && existingTask) {
                        return { outcome: 'existing', task: existingTask, decision: stateDecision };
                    }
                    throw new SuggestionAlreadyProcessedError(stateDecision);
                }
                if (
                    stateDecision?.kind === 'deferred'
                    && stateDecision.deferUntil != null
                    && now < stateDecision.deferUntil
                ) {
                    throw new SuggestionAlreadyProcessedError(stateDecision);
                }
                if (existingTask) {
                    const recoveredDecision: SuggestionDecisionRow = {
                        id: `sdec_${crypto.randomUUID()}`,
                        subjectId: subject.id,
                        occurrenceKey: occurrence.id,
                        suggestionId: suggestion.id,
                        kind: 'converted',
                        taskId: existingTask.id,
                        taskPublicId: existingTask.publicId,
                        createdAt: now,
                    };
                    await this.database.suggestionDecisions.add(recoveredDecision);
                    const outbox = protocolResponseOutbox(suggestion, recoveredDecision, now);
                    if (outbox) await this.database.agentProtocolOutbox.add(outbox);
                    return { outcome: 'existing', task: existingTask, decision: recoveredDecision };
                }

                const taskId = await this.database.tasks.add({
                    ...draft,
                    suggestionSubjectId: subject.id,
                    suggestionOccurrenceKey: occurrence.id,
                });
                const task = await this.database.tasks.get(taskId);
                if (!task) throw new Error('suggestion task was not persisted');
                const decision: SuggestionDecisionRow = {
                    id: `sdec_${crypto.randomUUID()}`,
                    subjectId: subject.id,
                    occurrenceKey: occurrence.id,
                    suggestionId: suggestion.id,
                    kind: 'converted',
                    taskId: task.id,
                    taskPublicId: task.publicId,
                    createdAt: now,
                };
                await this.database.suggestionDecisions.add(decision);
                const outbox = protocolResponseOutbox(suggestion, decision, now);
                if (outbox) await this.database.agentProtocolOutbox.add(outbox);
                return { outcome: 'created', task, decision };
            },
        );
    }

    async confirmSameOccurrence(
        suggestion: AgentSuggestion,
        targetOccurrenceKey: string,
        now = Date.now(),
    ): Promise<void> {
        await this.database.transaction(
            'rw',
            this.database.suggestionSubjects,
            this.database.suggestionOccurrences,
            this.database.suggestionDecisions,
            this.database.agentProtocolOutbox,
            async () => {
                const target = await this.database.suggestionOccurrences.get(targetOccurrenceKey);
                if (!target) throw new Error('target suggestion occurrence not found');
                const { identity, occurrence: candidate } = await this.ensureIdentityRows(suggestion, now);
                if (candidate.id === target.id) return;
                await this.database.suggestionOccurrences.put({
                    ...target,
                    aliases: unique([...target.aliases, candidate.id, identity.occurrenceKey]),
                    proposalIds: unique([...target.proposalIds, suggestion.id]),
                    updatedAt: now,
                });
                const decision: SuggestionDecisionRow = {
                    id: `sdec_${crypto.randomUUID()}`,
                    subjectId: target.subjectId,
                    occurrenceKey: target.id,
                    suggestionId: suggestion.id,
                    kind: 'commented',
                    comment: 'Uživatel potvrdil, že jde o stejnou událost.',
                    createdAt: now,
                };
                await this.database.suggestionDecisions.add(decision);
                const outbox = protocolResponseOutbox(suggestion, decision, now);
                if (outbox) await this.database.agentProtocolOutbox.add(outbox);
                // Keep the candidate occurrence as immutable history so any
                // prior decisions remain referentially valid. findOccurrence()
                // gives the target's alias precedence over this retained row.
            },
        );
    }

    async confirmDistinctSubjects(
        suggestion: AgentSuggestion,
        targetOccurrenceKey: string,
        now = Date.now(),
    ): Promise<void> {
        await this.database.transaction(
            'rw',
            this.database.suggestionSubjects,
            this.database.suggestionOccurrences,
            this.database.suggestionDecisions,
            this.database.agentProtocolOutbox,
            async () => {
                const targetOccurrence = await this.database.suggestionOccurrences.get(targetOccurrenceKey);
                if (!targetOccurrence) throw new Error('target suggestion occurrence not found');
                const targetSubject = await this.database.suggestionSubjects.get(targetOccurrence.subjectId);
                if (!targetSubject) throw new Error('target suggestion subject not found');
                const { subject: candidateSubject } = await this.ensureIdentityRows(suggestion, now);
                if (candidateSubject.id === targetSubject.id) {
                    throw new SuggestionRegistryConflictError('suggestions already belong to the same subject');
                }
                await Promise.all([
                    this.database.suggestionSubjects.put({
                        ...candidateSubject,
                        distinctFromSubjectIds: unique([
                            ...candidateSubject.distinctFromSubjectIds,
                            targetSubject.id,
                        ]),
                        updatedAt: now,
                    }),
                    this.database.suggestionSubjects.put({
                        ...targetSubject,
                        distinctFromSubjectIds: unique([
                            ...targetSubject.distinctFromSubjectIds,
                            candidateSubject.id,
                        ]),
                        updatedAt: now,
                    }),
                ]);
                const candidateOccurrence = await this.findOccurrence(deriveSuggestionIdentity(suggestion));
                if (!candidateOccurrence) throw new Error('candidate suggestion occurrence not found');
                const decision: SuggestionDecisionRow = {
                    id: `sdec_${crypto.randomUUID()}`,
                    subjectId: candidateSubject.id,
                    occurrenceKey: candidateOccurrence.id,
                    suggestionId: suggestion.id,
                    kind: 'commented',
                    comment: 'Uživatel potvrdil, že jde o novou samostatnou událost.',
                    createdAt: now,
                };
                await this.database.suggestionDecisions.add(decision);
                const outbox = protocolResponseOutbox(suggestion, decision, now);
                if (outbox) await this.database.agentProtocolOutbox.add(outbox);
            },
        );
    }
}

export const suggestionRegistry = new SuggestionRegistry();
