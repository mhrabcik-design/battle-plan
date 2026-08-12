/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSuggestion } from '../services/suggestionsSync.ts';
import {
    deriveSuggestionIdentity,
    suggestionTitleSimilarity,
} from './suggestionIdentity.ts';

function suggestion(overrides: Partial<AgentSuggestion> = {}): AgentSuggestion {
    return {
        id: 'proposal-a',
        created_at: 1,
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

test('legacy suggestion identity survives a new proposal id, case, spacing, and Czech diacritics', () => {
    const first = deriveSuggestionIdentity(suggestion());
    const replay = deriveSuggestionIdentity(suggestion({
        id: 'proposal-b',
        title: '  dph 7/26 - PRIPRAVIT   DOKLADY ',
        created_at: 9_999,
    }));

    assert.equal(replay.subjectId, first.subjectId);
    assert.equal(replay.occurrenceKey, first.occurrenceKey);
    assert.equal(replay.exactFingerprint, first.exactFingerprint);
});

test('legacy identity keeps materially different periods and source references separate', () => {
    const base = deriveSuggestionIdentity(suggestion());
    const nextPeriod = deriveSuggestionIdentity(suggestion({
        id: 'proposal-next-period',
        title: 'DPH 8/26 — Připravit doklady',
    }));
    const otherThread = deriveSuggestionIdentity(suggestion({
        id: 'proposal-other-thread',
        context: {
            ...suggestion().context,
            related_email_ids: ['thread-999'],
        },
    }));

    assert.notEqual(nextPeriod.occurrenceKey, base.occurrenceKey);
    assert.notEqual(otherThread.occurrenceKey, base.occurrenceKey);
});

test('producer subject and occurrence keys override the legacy fallback', () => {
    const identity = deriveSuggestionIdentity(suggestion({
        subject_id: 'tax-return-2026-07',
        occurrence_key: 'email-thread-123:request-documents:v1',
    }));

    assert.equal(identity.subjectId, 'tax-return-2026-07');
    assert.equal(identity.occurrenceKey, 'email-thread-123:request-documents:v1');
    assert.equal(identity.origin, 'producer');
});

test('title similarity can flag a possible duplicate without equating its identity', () => {
    const score = suggestionTitleSimilarity(
        'DPH 7/26 — Připravit doklady',
        'DPH 7/26 — Dodat podklady k přiznání',
    );

    assert.ok(score >= 0.45 && score < 1);
    assert.notEqual(
        deriveSuggestionIdentity(suggestion()).occurrenceKey,
        deriveSuggestionIdentity(suggestion({ title: 'DPH 7/26 — Dodat podklady k přiznání' })).occurrenceKey,
    );
});
