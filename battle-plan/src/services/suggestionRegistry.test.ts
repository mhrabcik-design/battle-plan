/// <reference types="node" />
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import Dexie from 'dexie';

import { BattlePlanDB, type Task } from '../db.ts';
import type { AgentSuggestion, AgentSuggestionReply } from './suggestionsSync.ts';
import { effectiveSuggestionStatus, SuggestionRegistry } from './suggestionRegistry.ts';

const databases: BattlePlanDB[] = [];

function createDatabase(): BattlePlanDB {
    const database = new BattlePlanDB(`SuggestionRegistry-${Date.now()}-${Math.random()}`);
    databases.push(database);
    return database;
}

afterEach(async () => {
    while (databases.length) {
        const database = databases.pop()!;
        database.close();
        await Dexie.delete(database.name);
    }
});

function suggestion(overrides: Partial<AgentSuggestion> = {}): AgentSuggestion {
    return {
        id: 'proposal-old',
        created_at: 100,
        source: 'Hermes',
        category: 'task',
        title: 'DPH 7/26 — Připravit doklady',
        description: 'Připrav podklady pro přiznání.',
        context: {
            related_task_ids: [],
            related_email_ids: ['thread-123'],
            deadline: null,
            priority: 'medium',
        },
        status: 'open',
        reply_count: 0,
        last_reply_at: null,
        ...overrides,
    };
}

const taskDraft: Omit<Task, 'id' | 'publicId' | 'suggestionSubjectId' | 'suggestionOccurrenceKey'> = {
    title: 'DPH 7/26 — Připravit doklady',
    description: 'Připrav podklady pro přiznání.',
    type: 'task',
    status: 'pending',
    urgency: 2,
    createdAt: 1_000,
    updatedAt: 1_000,
};

test('a terminal legacy decision suppresses the same occurrence under a new proposal id', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const oldSuggestion = suggestion({ status: 'converted', status_updated_at: 200 });
    const replay = suggestion({ id: 'proposal-new', created_at: 300, status: 'open' });

    await registry.ingestLegacy([oldSuggestion, replay], []);
    const resolution = await registry.resolve(replay);

    assert.equal(resolution.state, 'processed');
    assert.equal(resolution.decision?.kind, 'converted');
    assert.equal(resolution.matchedSuggestionId, 'proposal-old');
});

test('an accepted reply remains authoritative when a stale producer rewrites status to open', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const original = suggestion({ status: 'open' });
    const replay = suggestion({ id: 'proposal-new', created_at: 300, status: 'open' });
    const reply: AgentSuggestionReply = {
        id: 'reply-accepted',
        suggestion_id: original.id,
        created_at: 250,
        type: 'action',
        content: 'Accepted → task #42',
        action: 'accept',
        action_data: { convert_to_task: true },
    };

    await registry.ingestLegacy([original, replay], [reply]);
    const resolution = await registry.resolve(replay);

    assert.equal(resolution.state, 'processed');
    assert.equal(resolution.decision?.kind, 'converted');
});

test('conversion is atomic and idempotent for repeated approval', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const proposal = suggestion();

    const first = await registry.convertToTask(proposal, taskDraft);
    const second = await registry.convertToTask({ ...proposal, id: 'proposal-retry' }, taskDraft);

    assert.equal(first.outcome, 'created');
    assert.equal(second.outcome, 'existing');
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.task.publicId, first.task.publicId);
    assert.equal(await database.tasks.count(), 1);
    assert.equal(await database.suggestionDecisions.where('kind').equals('converted').count(), 1);
});

test('conversion rolls the task back when decision persistence fails', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    database.suggestionDecisions.hook('creating', () => {
        throw new Error('decision-write-failed');
    });

    await assert.rejects(
        () => registry.convertToTask(suggestion(), taskDraft),
        /decision-write-failed/,
    );
    assert.equal(await database.tasks.count(), 0);
    assert.equal(await database.suggestionDecisions.count(), 0);
    assert.equal(await database.agentProtocolOutbox.count(), 0);
});

test('a protocol decision creates a durable Hermes response with the same identity', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const proposal = suggestion({
        id: '11111111-1111-4111-8111-111111111111',
        subject_id: 'tax.vat-series',
        occurrence_key: 'tax.vat-2026-07',
    });

    const decision = await registry.recordDecision(proposal, { kind: 'rejected' }, 1_000);
    const response = await database.agentProtocolOutbox.get(`suggestion-response:${decision.id}`);

    assert.equal(response?.family, 'response');
    assert.deepEqual(response?.payload, {
        proposal_id: proposal.id,
        subject_id: proposal.subject_id,
        occurrence_key: proposal.occurrence_key,
        decision: 'rejected',
    });
    assert.equal(response?.status, 'pending');
});

test('conversion rolls back task and decision when the Hermes response cannot be queued', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const proposal = suggestion({
        id: '22222222-2222-4222-8222-222222222222',
        subject_id: 'tax.vat-series',
        occurrence_key: 'tax.vat-2026-07',
    });
    database.agentProtocolOutbox.hook('creating', () => {
        throw new Error('response-outbox-write-failed');
    });

    await assert.rejects(
        () => registry.convertToTask(proposal, taskDraft),
        /response-outbox-write-failed/,
    );
    assert.equal(await database.tasks.count(), 0);
    assert.equal(await database.suggestionDecisions.count(), 0);
    assert.equal(await database.agentProtocolOutbox.count(), 0);
});

test('fuzzy similarity is only a warning until the user confirms the occurrences are the same', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const processed = suggestion({ status: 'rejected', status_updated_at: 200 });
    const possibleReplay = suggestion({
        id: 'proposal-variant',
        title: 'DPH 7/26 — Dodat podklady k přiznání',
        status: 'open',
    });

    await registry.ingestLegacy([processed, possibleReplay], []);
    const warning = await registry.resolve(possibleReplay);
    assert.equal(warning.state, 'possible-duplicate');
    assert.equal(warning.decision?.kind, 'rejected');

    await registry.confirmSameOccurrence(possibleReplay, warning.matchedOccurrenceKey!);
    const confirmed = await registry.resolve(possibleReplay);
    assert.equal(confirmed.state, 'processed');
    assert.equal(confirmed.decision?.kind, 'rejected');
});

test('confirming the same occurrence retains prior decision history with valid references', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const processed = suggestion({ status: 'rejected', status_updated_at: 200 });
    const possibleReplay = suggestion({
        id: 'proposal-expired-defer',
        title: 'DPH 7/26 — Dodat doklady k přiznání',
        status: 'open',
    });

    await registry.ingestLegacy([processed], []);
    await registry.recordDecision(possibleReplay, { kind: 'deferred', deferUntil: 300 }, 250);
    const warning = await registry.resolve(possibleReplay, 400);
    assert.equal(warning.state, 'possible-duplicate');

    await registry.confirmSameOccurrence(possibleReplay, warning.matchedOccurrenceKey!, 500);

    const snapshot = await registry.exportSnapshot(600);
    const occurrenceIds = new Set(snapshot.occurrences.map((row) => row.id));
    assert.ok(snapshot.decisions.every((row) => occurrenceIds.has(row.occurrenceKey)));
    assert.equal((await registry.resolve(possibleReplay, 600)).decision?.kind, 'rejected');
});

test('re-ingesting an unchanged legacy decision preserves its published state', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const processed = suggestion({ status: 'rejected', status_updated_at: 200 });

    await registry.ingestLegacy([processed], []);
    const [decision] = (await registry.exportSnapshot()).decisions;
    await registry.markPublished([decision.id], 300);
    await registry.ingestLegacy([processed], []);

    assert.equal((await registry.exportSnapshot()).decisions[0].publishedAt, 300);
});

test('legacy defer replies remain time-bounded and status alone cannot defer forever', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const deferred = suggestion({ status: 'deferred', status_updated_at: 200 });
    const reply: AgentSuggestionReply = {
        id: 'reply-defer',
        suggestion_id: deferred.id,
        created_at: 250,
        type: 'action',
        content: 'Deferred to 2026-08-20',
        action: 'defer',
        action_data: { defer_until: '2026-08-20' },
    };
    const deferUntil = Date.parse('2026-08-20T00:00:00');

    await registry.ingestLegacy([deferred], [reply]);

    assert.equal((await registry.resolve(deferred, deferUntil - 1)).state, 'deferred');
    assert.equal((await registry.resolve(deferred, deferUntil + 1)).state, 'open');

    const statusOnly = suggestion({
        id: 'status-only',
        title: 'Jiný návrh bez data odložení',
        status: 'deferred',
        status_updated_at: 300,
    });
    await registry.ingestLegacy([statusOnly], []);
    assert.equal((await registry.resolve(statusOnly, 400)).state, 'open');
});

test('new occurrence of the same producer subject stays actionable without fuzzy confirmation', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const processed = suggestion({
        id: 'proposal-first',
        subject_id: 'tax.vat-series',
        occurrence_key: 'tax.vat-2026-07',
        status: 'rejected',
        status_updated_at: 200,
    });
    const nextOccurrence = suggestion({
        id: 'proposal-second',
        subject_id: 'tax.vat-series',
        occurrence_key: 'tax.vat-2026-08',
        title: 'DPH 8/26 — Připravit doklady',
        status: 'open',
    });

    await registry.ingestLegacy([processed, nextOccurrence], []);

    assert.equal((await registry.resolve(nextOccurrence, 300)).state, 'open');
});

test('a user can mark a fuzzy match as distinct and keep both suggestions actionable', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const processed = suggestion({ status: 'rejected', status_updated_at: 200 });
    const genuinelyNew = suggestion({
        id: 'proposal-new-event',
        title: 'DPH 7/26 — Dodat podklady k přiznání',
        status: 'open',
    });

    await registry.ingestLegacy([processed, genuinelyNew], []);
    const warning = await registry.resolve(genuinelyNew);
    assert.equal(warning.state, 'possible-duplicate');

    await registry.confirmDistinctSubjects(genuinelyNew, warning.matchedOccurrenceKey!);
    const confirmed = await registry.resolve(genuinelyNew);
    assert.equal(confirmed.state, 'commented');
    assert.equal(effectiveSuggestionStatus(genuinelyNew, confirmed), 'open');
});

test('terminal registry decisions drive display status even when producer status is stale', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const proposal = suggestion({ status: 'open' });

    await registry.recordDecision(proposal, { kind: 'rejected' }, 1_000);
    const resolution = await registry.resolve({ ...proposal, id: 'proposal-replayed' });

    assert.equal(effectiveSuggestionStatus(proposal, resolution), 'rejected');
});

test('comment is non-terminal and defer suppresses only until its date', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const proposal = suggestion();

    await registry.recordDecision(proposal, { kind: 'commented', comment: 'Doplň podklady.' }, 1_000);
    assert.equal((await registry.resolve(proposal, 2_000)).state, 'commented');

    await registry.recordDecision(proposal, { kind: 'deferred', deferUntil: 10_000 }, 3_000);
    assert.equal((await registry.resolve(proposal, 9_000)).state, 'deferred');
    assert.equal((await registry.resolve(proposal, 10_001)).state, 'commented');
});

test('a terminal decision stays processed even if a stale device writes a later defer', async () => {
    const database = createDatabase();
    const registry = new SuggestionRegistry(database);
    const proposal = suggestion();

    await registry.recordDecision(proposal, { kind: 'rejected' }, 1_000);
    await registry.recordDecision(proposal, { kind: 'deferred', deferUntil: 20_000 }, 2_000);

    const resolution = await registry.resolve(proposal, 3_000);
    assert.equal(resolution.state, 'processed');
    assert.equal(resolution.decision?.kind, 'rejected');
});
