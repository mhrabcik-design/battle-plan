import type {
    SuggestionDecisionRow,
    SuggestionOccurrenceRow,
    SuggestionSubjectRow,
} from '../db.ts';
import { getErrorMessage } from '../utils/errors.ts';
import type {
    DriveJsonStore,
    DriveStoreStatus,
} from './driveJsonStore.ts';
import {
    suggestionRegistry,
    type SuggestionRegistry,
    type SuggestionRegistrySnapshot,
} from './suggestionRegistry.ts';

const REGISTRY_FILENAME = 'agent-suggestion-decisions.json';
const MAX_PUBLISH_ATTEMPTS = 3;

export type SuggestionRegistryFile = SuggestionRegistrySnapshot;

export type SuggestionRegistryStore = Pick<
    DriveJsonStore,
    'init' | 'readJsonFilesWithStatus' | 'writeJsonFile'
> & Partial<Pick<DriveJsonStore, 'lastStatus'>>;

class LazyDriveRegistryStore implements SuggestionRegistryStore {
    private delegate: SuggestionRegistryStore | null = null;

    get lastStatus(): DriveStoreStatus | undefined {
        return this.delegate?.lastStatus;
    }

    private async store(): Promise<SuggestionRegistryStore> {
        if (!this.delegate) {
            const { DriveJsonStore } = await import('./driveJsonStore.ts');
            this.delegate = new DriveJsonStore();
        }
        return this.delegate;
    }

    async init(options?: { createFolder?: boolean }): Promise<boolean> {
        return (await this.store()).init(options);
    }

    async readJsonFilesWithStatus<T>(name: string) {
        return (await this.store()).readJsonFilesWithStatus<T>(name);
    }

    async writeJsonFile(
        name: string,
        payload: unknown,
        fileId?: string | null,
        options?: { ifMatch?: string; createOnly?: boolean },
    ) {
        return (await this.store()).writeJsonFile(name, payload, fileId, options);
    }
}

export type SuggestionRegistrySyncResult =
    | { kind: 'loaded' }
    | { kind: 'missing-file' }
    | { kind: 'published'; decisionCount: number }
    | { kind: 'nothing-pending' }
    | { kind: 'store-unavailable'; status?: DriveStoreStatus }
    | { kind: 'error'; message: string };

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || isFiniteNumber(value);
}

function isSubject(value: unknown): value is SuggestionSubjectRow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<SuggestionSubjectRow>;
    return typeof row.id === 'string'
        && typeof row.canonicalFingerprint === 'string'
        && isStringArray(row.aliases)
        && isStringArray(row.distinctFromSubjectIds)
        && typeof row.title === 'string'
        && typeof row.category === 'string'
        && typeof row.source === 'string'
        && isFiniteNumber(row.createdAt)
        && isFiniteNumber(row.updatedAt);
}

function isOccurrence(value: unknown): value is SuggestionOccurrenceRow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<SuggestionOccurrenceRow>;
    return typeof row.id === 'string'
        && typeof row.subjectId === 'string'
        && isStringArray(row.aliases)
        && isStringArray(row.proposalIds)
        && typeof row.exactFingerprint === 'string'
        && typeof row.titleSnapshot === 'string'
        && isStringArray(row.sourceScope)
        && isFiniteNumber(row.createdAt)
        && isFiniteNumber(row.updatedAt);
}

const DECISION_KINDS = new Set([
    'commented',
    'deferred',
    'accepted',
    'converted',
    'rejected',
    'dismissed',
    'reopened',
]);

function isDecision(value: unknown): value is SuggestionDecisionRow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<SuggestionDecisionRow>;
    const hasValidTaskId = row.taskId === undefined
        || (Number.isSafeInteger(row.taskId) && row.taskId > 0);
    const taskFieldsMatchKind = row.kind === 'converted'
        || (row.taskId === undefined && row.taskPublicId === undefined);
    const deferMatchesKind = row.kind !== 'deferred' || isFiniteNumber(row.deferUntil);
    return typeof row.id === 'string'
        && typeof row.subjectId === 'string'
        && typeof row.occurrenceKey === 'string'
        && typeof row.suggestionId === 'string'
        && typeof row.kind === 'string'
        && DECISION_KINDS.has(row.kind)
        && isOptionalString(row.comment)
        && isOptionalFiniteNumber(row.deferUntil)
        && hasValidTaskId
        && isOptionalString(row.taskPublicId)
        && isFiniteNumber(row.createdAt)
        && isOptionalFiniteNumber(row.publishedAt)
        && taskFieldsMatchKind
        && deferMatchesKind;
}

function parseRegistryFile(value: unknown): SuggestionRegistryFile {
    if (!value || typeof value !== 'object') throw new Error('registr rozhodnutí nemá platný formát');
    const file = value as Partial<SuggestionRegistryFile>;
    if (
        file.version !== 1
        || !Array.isArray(file.subjects)
        || !file.subjects.every(isSubject)
        || !Array.isArray(file.occurrences)
        || !file.occurrences.every(isOccurrence)
        || !Array.isArray(file.decisions)
        || !file.decisions.every(isDecision)
    ) {
        throw new Error('registr rozhodnutí nemá platný formát');
    }
    return file as SuggestionRegistryFile;
}

export class SuggestionRegistrySync {
    private readonly registry: SuggestionRegistry;
    private readonly store: SuggestionRegistryStore;

    constructor(
        registry: SuggestionRegistry = suggestionRegistry,
        store: SuggestionRegistryStore = new LazyDriveRegistryStore(),
    ) {
        this.registry = registry;
        this.store = store;
    }

    private async initStore(): Promise<SuggestionRegistrySyncResult | null> {
        try {
            if (await this.store.init({ createFolder: true })) return null;
            const status = this.store.lastStatus;
            return { kind: 'store-unavailable', ...(status ? { status } : {}) };
        } catch (error) {
            return { kind: 'error', message: getErrorMessage(error) };
        }
    }

    private async convergeRemote(pendingIds: readonly string[]): Promise<SuggestionRegistrySyncResult> {
        try {
            for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
                const read = await this.store.readJsonFilesWithStatus<unknown>(REGISTRY_FILENAME);
                if (read.kind === 'store-unavailable' || read.kind === 'error') return read;
                if (read.kind === 'missing-file' && pendingIds.length === 0) return { kind: 'missing-file' };
                const files = read.kind === 'loaded' ? read.files : [];
                const remoteIds = new Set<string>();
                for (const file of files) {
                    const remoteSnapshot = parseRegistryFile(file.data);
                    await this.registry.mergeSnapshot(remoteSnapshot);
                    for (const decision of remoteSnapshot.decisions) remoteIds.add(decision.id);
                }
                if (pendingIds.length === 0) return { kind: 'loaded' };
                if (pendingIds.every((id) => remoteIds.has(id))) {
                    await this.registry.markPublished(pendingIds);
                    return { kind: 'published', decisionCount: pendingIds.length };
                }

                const snapshot = await this.registry.exportSnapshot();
                const saved = await this.store.writeJsonFile(
                    REGISTRY_FILENAME,
                    snapshot,
                    null,
                    { createOnly: true },
                );
                if (!saved) continue;

                const verification = await this.store.readJsonFilesWithStatus<unknown>(REGISTRY_FILENAME);
                if (verification.kind !== 'loaded') continue;
                const verifiedIds = new Set<string>();
                const verifiedSnapshots: SuggestionRegistryFile[] = [];
                for (const file of verification.files) {
                    const verifiedSnapshot = parseRegistryFile(file.data);
                    verifiedSnapshots.push(verifiedSnapshot);
                    for (const decision of verifiedSnapshot.decisions) verifiedIds.add(decision.id);
                }
                if (pendingIds.some((id) => !verifiedIds.has(id))) continue;
                for (const verifiedSnapshot of verifiedSnapshots) {
                    await this.registry.mergeSnapshot(verifiedSnapshot);
                }

                await this.registry.markPublished(pendingIds);
                return { kind: 'published', decisionCount: pendingIds.length };
            }
            return { kind: 'error', message: 'Zápis registru rozhodnutí se nepodařilo ověřit.' };
        } catch (error) {
            return { kind: 'error', message: getErrorMessage(error) };
        }
    }

    async fetchAndMerge(): Promise<SuggestionRegistrySyncResult> {
        const unavailable = await this.initStore();
        if (unavailable) return unavailable;
        return this.convergeRemote([]);
    }

    async publishPending(): Promise<SuggestionRegistrySyncResult> {
        const unavailable = await this.initStore();
        if (unavailable) return unavailable;
        const initial = await this.registry.exportSnapshot();
        const pendingIds = initial.decisions
            .filter((decision) => decision.publishedAt == null)
            .map((decision) => decision.id);
        if (pendingIds.length === 0) return { kind: 'nothing-pending' };

        return this.convergeRemote(pendingIds);
    }
}

export const suggestionRegistrySync = new SuggestionRegistrySync();
