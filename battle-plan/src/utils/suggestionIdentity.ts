import type { AgentSuggestion } from '../services/suggestionsSync.ts';

export interface SuggestionIdentity {
    subjectId: string;
    occurrenceKey: string;
    exactFingerprint: string;
    normalizedTitle: string;
    sourceScope: string[];
    origin: 'producer' | 'legacy';
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const WORDS = /[a-z0-9]+/g;

export function normalizeSuggestionText(value: string): string {
    return value
        .normalize('NFKD')
        .replace(COMBINING_MARKS, '')
        .toLocaleLowerCase('cs-CZ')
        .match(WORDS)
        ?.join(' ')
        .trim() ?? '';
}

function fnv1a64(value: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    const bytes = new TextEncoder().encode(value);
    for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
}

function collectSourceScope(suggestion: AgentSuggestion): string[] {
    const refs = new Set<string>();
    for (const ref of suggestion.source_refs ?? []) {
        const kind = normalizeSuggestionText(ref.kind);
        const id = normalizeSuggestionText(ref.id);
        const revision = normalizeSuggestionText(ref.revision ?? '');
        if (kind && id) refs.add(`${kind}:${id}${revision ? `:${revision}` : ''}`);
    }
    for (const id of suggestion.context.related_email_ids ?? []) {
        const normalized = normalizeSuggestionText(id);
        if (normalized) refs.add(`email:${normalized}`);
    }
    for (const id of suggestion.context.related_task_ids ?? []) {
        refs.add(`task:${id}`);
    }
    if (refs.size === 0) {
        const source = normalizeSuggestionText(suggestion.source ?? '');
        if (source) refs.add(`source:${source}`);
    }
    return [...refs].sort();
}

export function deriveSuggestionIdentity(suggestion: AgentSuggestion): SuggestionIdentity {
    const normalizedTitle = normalizeSuggestionText(suggestion.title);
    const sourceScope = collectSourceScope(suggestion);
    const canonical = [
        'suggestion-v1',
        normalizeSuggestionText(suggestion.category),
        normalizedTitle,
        ...sourceScope,
    ].join('|');
    const exactFingerprint = `sg_${fnv1a64(canonical)}`;
    const producerSubjectId = suggestion.subject_id?.trim();
    const producerOccurrenceKey = suggestion.occurrence_key?.trim();

    if (producerSubjectId && producerOccurrenceKey) {
        return {
            subjectId: producerSubjectId,
            occurrenceKey: producerOccurrenceKey,
            exactFingerprint,
            normalizedTitle,
            sourceScope,
            origin: 'producer',
        };
    }

    return {
        subjectId: exactFingerprint,
        occurrenceKey: exactFingerprint,
        exactFingerprint,
        normalizedTitle,
        sourceScope,
        origin: 'legacy',
    };
}

function tokenize(value: string): Set<string> {
    return new Set(normalizeSuggestionText(value).split(' ').filter((token) => token.length >= 2));
}

export function suggestionTitleSimilarity(left: string, right: string): number {
    const a = tokenize(left);
    const b = tokenize(right);
    if (a.size === 0 || b.size === 0) return 0;
    if (a.size === b.size && [...a].every((token) => b.has(token))) return 1;

    let overlap = 0;
    for (const token of a) if (b.has(token)) overlap++;
    const dice = (2 * overlap) / (a.size + b.size);
    const aNumbers = [...a].filter((token) => /^\d+$/.test(token));
    const bNumbers = [...b].filter((token) => /^\d+$/.test(token));
    const sameNumbers = aNumbers.length > 0
        && aNumbers.length === bNumbers.length
        && aNumbers.every((token) => bNumbers.includes(token));
    return sameNumbers ? 0.2 + (dice * 0.8) : dice;
}
