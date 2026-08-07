import type { AgentSuggestionReply } from '../services/suggestionsSync.ts';

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
