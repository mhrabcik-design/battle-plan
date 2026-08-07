import type {
    AgentSuggestionReply,
    RepliesFetchResult,
} from '../services/suggestionsSync.ts';

export type SuggestionsSnapshotResolution =
    | { kind: 'replace'; repliesBySuggestion: Record<string, AgentSuggestionReply[]> }
    | { kind: 'preserve'; message: string };

export function groupSuggestionReplies(
    suggestionIds: readonly string[],
    replies: readonly AgentSuggestionReply[],
): Record<string, AgentSuggestionReply[]> {
    const grouped: Record<string, AgentSuggestionReply[]> = Object.fromEntries(
        suggestionIds.map((id) => [id, []]),
    );

    for (const reply of replies) {
        grouped[reply.suggestion_id]?.push(reply);
    }

    for (const [suggestionId, values] of Object.entries(grouped)) {
        grouped[suggestionId] = values.sort((a, b) => a.created_at - b.created_at);
    }

    return grouped;
}

export function resolveSuggestionsSnapshot(
    suggestions: readonly { id: string }[],
    repliesResult: RepliesFetchResult,
): SuggestionsSnapshotResolution {
    if (repliesResult.kind === 'loaded' || repliesResult.kind === 'missing-file') {
        return {
            kind: 'replace',
            repliesBySuggestion: groupSuggestionReplies(
                suggestions.map((suggestion) => suggestion.id),
                repliesResult.replies,
            ),
        };
    }

    if (repliesResult.kind === 'store-unavailable') {
        return {
            kind: 'preserve',
            message: `Suggestions: Odpovědi nejsou dostupné (${repliesResult.status.message}); zachovávám poslední úplný stav.`,
        };
    }

    return {
        kind: 'preserve',
        message: `Suggestions: Odpovědi se nepodařilo načíst (${repliesResult.message}); zachovávám poslední úplný stav.`,
    };
}
