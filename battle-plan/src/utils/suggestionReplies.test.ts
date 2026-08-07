/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSuggestionReply } from '../services/suggestionsSync.ts';
import {
    groupSuggestionReplies,
    resolveSuggestionsSnapshot,
} from './suggestionReplies.ts';

test('groupSuggestionReplies groups known suggestions, sorts chronologically, and keeps input immutable', () => {
    const replies: AgentSuggestionReply[] = [
        { id: 'late', suggestion_id: 's-1', created_at: 30, type: 'text', content: 'později', action: null },
        { id: 'other', suggestion_id: 's-2', created_at: 20, type: 'action', content: 'hotovo', action: 'accept' },
        { id: 'early', suggestion_id: 's-1', created_at: 10, type: 'text', content: 'dříve', action: null },
        { id: 'orphan', suggestion_id: 'unknown', created_at: 5, type: 'text', content: 'mimo', action: null },
    ];
    const originalOrder = replies.map((reply) => reply.id);

    const grouped = groupSuggestionReplies(['s-1', 's-2', 's-3'], replies);

    assert.deepEqual(Object.fromEntries(
        Object.entries(grouped).map(([id, values]) => [id, values.map((reply) => reply.id)]),
    ), {
        's-1': ['early', 'late'],
        's-2': ['other'],
        's-3': [],
    });
    assert.deepEqual(replies.map((reply) => reply.id), originalOrder);
});

test('resolveSuggestionsSnapshot replaces state for loaded and confirmed missing reply files', () => {
    const suggestions = [{ id: 's-1' }, { id: 's-2' }];
    const reply: AgentSuggestionReply = {
        id: 'r-1',
        suggestion_id: 's-1',
        created_at: 10,
        type: 'text',
        content: 'poznámka',
        action: null,
    };

    const loaded = resolveSuggestionsSnapshot(suggestions, {
        kind: 'loaded',
        replies: [reply],
    });
    const missing = resolveSuggestionsSnapshot(suggestions, {
        kind: 'missing-file',
        replies: [],
    });

    assert.equal(loaded.kind, 'replace');
    assert.deepEqual(loaded.kind === 'replace' ? loaded.repliesBySuggestion : null, {
        's-1': [reply],
        's-2': [],
    });
    assert.deepEqual(missing, {
        kind: 'replace',
        repliesBySuggestion: {
            's-1': [],
            's-2': [],
        },
    });
});

test('resolveSuggestionsSnapshot preserves the last complete state on transient reply failures', () => {
    const suggestions = [{ id: 's-1' }];

    const unavailable = resolveSuggestionsSnapshot(suggestions, {
        kind: 'store-unavailable',
        status: { code: 'auth-unavailable', message: 'Google autorizace vypršela' },
        replies: [],
    });
    const failed = resolveSuggestionsSnapshot(suggestions, {
        kind: 'error',
        message: '500 Drive temporarily unavailable',
        replies: [],
    });

    assert.deepEqual(unavailable, {
        kind: 'preserve',
        message: 'Suggestions: Odpovědi nejsou dostupné (Google autorizace vypršela); zachovávám poslední úplný stav.',
    });
    assert.deepEqual(failed, {
        kind: 'preserve',
        message: 'Suggestions: Odpovědi se nepodařilo načíst (500 Drive temporarily unavailable); zachovávám poslední úplný stav.',
    });
});
