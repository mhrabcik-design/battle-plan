/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSuggestionReply } from '../services/suggestionsSync.ts';
import { groupSuggestionReplies } from './suggestionReplies.ts';

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
