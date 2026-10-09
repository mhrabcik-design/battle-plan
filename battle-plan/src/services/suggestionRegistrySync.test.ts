/// <reference types="node" />
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import Dexie from 'dexie';

import { BattlePlanDB } from '../db.ts';
import { SuggestionRegistry } from './suggestionRegistry.ts';
import {
    SuggestionRegistrySync,
    type SuggestionRegistryFile,
    type SuggestionRegistryStore,
} from './suggestionRegistrySync.ts';
import type { AgentSuggestion } from './suggestionsSync.ts';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
const { googleService } = await import('./googleService.ts');

const databases: BattlePlanDB[] = [];

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

test('new account registry refresh does not share an old account read or its cleanup', async (t) => {
    let account = 'account-a';
    t.mock.method(googleService, 'getAccountId', () => account);
    const localRegistry = createRegistry();
    const oldRegistry = createRegistry();
    await oldRegistry.recordDecision(suggestion({ id: 'proposal-old' }), { kind: 'rejected' }, 1_000);
    const oldSnapshot = await oldRegistry.exportSnapshot();
    const newRegistry = createRegistry();
    await newRegistry.recordDecision(suggestion({ id: 'proposal-new', title: 'Nový účet' }), { kind: 'accepted' }, 1_100);
    const newSnapshot = await newRegistry.exportSnapshot();
    const oldStarted = deferred();
    const oldRelease = deferred();
    const newStarted = deferred();
    const newRelease = deferred();
    t.after(() => { oldRelease.resolve(); newRelease.resolve(); });
    const store = new FakeRegistryStore();
    store.readJsonFilesWithStatus = async <T>() => {
        const owner = account;
        store.readCount++;
        if (owner === 'account-a') { oldStarted.resolve(); await oldRelease.promise; }
        else { newStarted.resolve(); await newRelease.promise; }
        return { kind: 'loaded', files: [{ fileId: owner, data: structuredClone(owner === 'account-a' ? oldSnapshot : newSnapshot) as T }] };
    };
    const sync = new SuggestionRegistrySync(localRegistry, store);
    const oldRefresh = sync.fetchAndMerge();
    await oldStarted.promise;
    account = 'account-b';
    const newRefresh = sync.fetchAndMerge();
    // Allow the new call to enter its read without waiting forever on a broken shared flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.readCount, 2);
    await newStarted.promise;
    oldRelease.resolve();
    assert.equal((await oldRefresh).kind, 'error');
    const overlappingNewRefresh = sync.fetchAndMerge();
    newRelease.resolve();
    assert.equal((await newRefresh).kind, 'loaded');
    assert.equal((await overlappingNewRefresh).kind, 'loaded');
    assert.equal(store.readCount, 2, 'old cleanup must not remove the new account flight');
    const local = await localRegistry.exportSnapshot();
    assert.deepEqual(local.decisions.map((row) => row.suggestionId), ['proposal-new']);
});

test('registry publication stops when the account changes during snapshot export', async (t) => {
    let account = 'account-a';
    t.mock.method(googleService, 'getAccountId', () => account);
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const started = deferred();
    const release = deferred();
    const exportSnapshot = registry.exportSnapshot.bind(registry);
    let exports = 0;
    t.mock.method(registry, 'exportSnapshot', async () => {
        const result = await exportSnapshot();
        if (++exports === 2) { started.resolve(); await release.promise; }
        return result;
    });
    const store = new FakeRegistryStore();
    const publication = new SuggestionRegistrySync(registry, store).publishPending();
    await started.promise;
    account = 'account-b';
    release.resolve();
    assert.equal((await publication).kind, 'error');
    assert.equal(store.writeCount, 0, 'the old snapshot must never be sent to the new account');
    assert.equal((await exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt, undefined);
});

test('registry fetch rolls back a local merge if account ownership changes inside its transaction', async (t) => {
    let account = 'account-a';
    t.mock.method(googleService, 'getAccountId', () => account);
    const remoteRegistry = createRegistry();
    await remoteRegistry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    store.data = await remoteRegistry.exportSnapshot();
    const localRegistry = createRegistry();
    const database = databases.at(-1)!;
    const put = database.suggestionSubjects.put.bind(database.suggestionSubjects);
    t.mock.method(database.suggestionSubjects, 'put', async (...args: Parameters<typeof put>) => {
        const result = await put(...args);
        account = 'account-b';
        return result;
    });

    const result = await new SuggestionRegistrySync(localRegistry, store).fetchAndMerge();

    assert.equal(result.kind, 'error');
    const snapshot = await localRegistry.exportSnapshot();
    assert.equal(snapshot.subjects.length, 0);
    assert.equal(snapshot.occurrences.length, 0);
    assert.equal(snapshot.decisions.length, 0);
});

test('registry verification from an old login cannot mark decisions published after A to B to A', async (t) => {
    let account = 'account-a';
    let generation = 1;
    t.mock.method(googleService, 'getAccountId', () => account);
    t.mock.method(googleService, 'getAuthGeneration', () => generation);
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    const started = deferred();
    const release = deferred();
    const read = store.readJsonFilesWithStatus.bind(store);
    store.readJsonFilesWithStatus = async <T>() => {
        const result = await read<T>();
        if (store.readCount === 2) { started.resolve(); await release.promise; }
        return result;
    };
    const publication = new SuggestionRegistrySync(registry, store).publishPending();
    await started.promise;
    account = 'account-b'; generation++;
    account = 'account-a'; generation++;
    release.resolve();
    assert.equal((await publication).kind, 'error');
    assert.equal(store.writeCount, 1);
    assert.equal((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt, undefined);
});

test('overlapping page and badge registry refreshes share one remote read', async () => {
    const registry = createRegistry();
    const store = new FakeRegistryStore();
    const sync = new SuggestionRegistrySync(registry, store);
    await Promise.all([sync.fetchAndMerge(), sync.fetchAndMerge()]);
    assert.equal(store.readCount, 1);
    await sync.fetchAndMerge();
    assert.equal(store.readCount, 2, 'a later refresh must still check Drive');
});

function createRegistry(): SuggestionRegistry {
    const database = new BattlePlanDB(`SuggestionRegistrySync-${Date.now()}-${Math.random()}`);
    databases.push(database);
    return new SuggestionRegistry(database);
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
        id: 'proposal-a',
        created_at: 100,
        source: 'Hermes',
        category: 'task',
        title: 'DPH 7/26 — Připravit doklady',
        description: '',
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

class FakeRegistryStore implements SuggestionRegistryStore {
    data: SuggestionRegistryFile | null = null;
    duplicateData: SuggestionRegistryFile[] = [];
    trashedFileIds: string[] = [];
    writeCalls: Array<{ fileId?: string | null; options?: unknown }> = [];
    readCount = 0;
    writeCount = 0;
    initialized = true;
    dropNextWrite = false;
    failReadCounts = new Set<number>();
    writeError: Error | null = null;
    etag = '"registry-etag-a"';
    omitEtag = false;

    async init(): Promise<boolean> {
        return this.initialized;
    }

    async readJsonFilesWithStatus<T>(): Promise<
        | { kind: 'loaded'; files: Array<{ fileId: string; etag?: string; data: T }> }
        | { kind: 'missing-file' }
        | { kind: 'error'; message: string }
    > {
        this.readCount++;
        if (this.failReadCounts.has(this.readCount)) {
            return { kind: 'error', message: 'Drive read failed' };
        }
        return this.data
            ? {
                kind: 'loaded',
                files: [
                    {
                        fileId: 'registry-a',
                        ...(!this.omitEtag ? { etag: this.etag } : {}),
                        data: structuredClone(this.data) as T,
                    },
                    ...this.duplicateData.map((data, index) => ({
                        fileId: `registry-${String.fromCharCode(98 + index)}`,
                        etag: `"registry-etag-${index + 2}"`,
                        data: structuredClone(data) as T,
                    })),
                ],
            }
            : { kind: 'missing-file' };
    }

    async writeJsonFile(
        _name: string,
        payload: unknown,
        fileId?: string | null,
        options?: unknown,
    ): Promise<{ fileId: string } | null> {
        this.writeCount++;
        this.writeCalls.push({ fileId, options });
        if (this.writeError) throw this.writeError;
        if (this.dropNextWrite) {
            this.dropNextWrite = false;
        } else {
            const snapshot = structuredClone(payload) as SuggestionRegistryFile;
            if (this.data && (options as { createOnly?: boolean } | undefined)?.createOnly) {
                this.duplicateData.push(snapshot);
            } else {
                this.data = snapshot;
            }
        }
        return { fileId: `registry-${String.fromCharCode(97 + this.duplicateData.length)}` };
    }

    async trashFile(fileId: string): Promise<void> {
        this.trashedFileIds.push(fileId);
        const index = fileId.charCodeAt(fileId.length - 1) - 98;
        if (index >= 0) this.duplicateData.splice(index, 1);
    }
}

test('publishing verifies the journal and retries a lost create response', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    store.dropNextWrite = true;
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.equal(result.kind, 'published');
    assert.equal(store.writeCount, 2);
    assert.ok(store.data?.decisions.some((row) => row.id === decision.id));
    assert.ok((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt);
});

test('publishing recognizes an already-created snapshot without creating a duplicate', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    store.data = await registry.exportSnapshot();
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.deepEqual(result, { kind: 'published', decisionCount: 1 });
    assert.equal(store.writeCount, 0);
    assert.ok((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt);
});

test('publishing creates a snapshot without requiring an ETag and preserves a concurrent registry', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const concurrentRemote = createRegistry();
    await concurrentRemote.recordDecision(
        suggestion({
            id: 'proposal-remote',
            title: 'Souběžné rozhodnutí',
            context: {
                related_task_ids: [],
                related_email_ids: ['thread-remote'],
                deadline: null,
                priority: 'medium',
            },
        }),
        { kind: 'accepted' },
        1_100,
    );
    const store = new FakeRegistryStore();
    store.data = await concurrentRemote.exportSnapshot();
    store.omitEtag = true;
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.equal(result.kind, 'published');
    assert.equal(store.writeCount, 1);
    assert.equal(store.readCount, 2);
    assert.deepEqual(store.writeCalls, [
        { fileId: null, options: { createOnly: true } },
    ]);
    assert.equal(store.trashedFileIds.length, 0);
    assert.ok(store.duplicateData[0]?.decisions.some((row) => row.id === decision.id));
    assert.ok(store.duplicateData[0]?.decisions.some((row) => row.suggestionId === 'proposal-remote'));
    assert.ok((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt);
});

test('fetching a remote terminal decision protects a new local proposal id', async () => {
    const remoteRegistry = createRegistry();
    const original = suggestion();
    await remoteRegistry.recordDecision(original, { kind: 'rejected' }, 1_000);

    const store = new FakeRegistryStore();
    store.data = await remoteRegistry.exportSnapshot();
    const localRegistry = createRegistry();
    const sync = new SuggestionRegistrySync(localRegistry, store);

    assert.equal((await sync.fetchAndMerge()).kind, 'loaded');
    const replay = suggestion({ id: 'proposal-new', created_at: 2_000 });
    const resolution = await localRegistry.resolve(replay);
    assert.equal(resolution.state, 'processed');
    assert.equal(resolution.decision?.kind, 'rejected');
});

test('a Drive outage keeps the local decision pending and reports the partial state', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    store.initialized = false;
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.equal(result.kind, 'store-unavailable');
    assert.equal((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt, undefined);
});

test('a failed create keeps the local decision pending', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    store.writeError = new Error('Drive create failed');
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.deepEqual(result, { kind: 'error', message: 'Drive create failed' });
    assert.equal((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt, undefined);
});

test('a failed verification reread keeps the local decision pending for an idempotent retry', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    store.failReadCounts = new Set([2, 3]);
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.deepEqual(result, { kind: 'error', message: 'Drive read failed' });
    assert.equal((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt, undefined);
});

test('a conflicting remote decision fails closed and leaves the local journal unchanged', async () => {
    const registry = createRegistry();
    const proposal = suggestion();
    const decision = await registry.recordDecision(proposal, { kind: 'rejected' }, 1_000);
    const conflicting = await registry.exportSnapshot();
    conflicting.decisions = conflicting.decisions.map((row) =>
        row.id === decision.id ? { ...row, kind: 'accepted' } : row
    );
    const store = new FakeRegistryStore();
    store.data = conflicting;
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.fetchAndMerge();

    assert.equal(result.kind, 'error');
    assert.equal((await registry.resolve(proposal)).decision?.kind, 'rejected');
});

test('a malformed remote registry is rejected without clearing local decisions', async () => {
    const registry = createRegistry();
    const proposal = suggestion();
    await registry.recordDecision(proposal, { kind: 'rejected' }, 1_000);
    const store = new FakeRegistryStore();
    store.data = { version: 1, last_updated: 2_000, subjects: [], occurrences: [], decisions: [{}] } as never;
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.fetchAndMerge();

    assert.equal(result.kind, 'error');
    assert.equal((await registry.resolve(proposal)).decision?.kind, 'rejected');
});

test('malformed optional decision fields are rejected before Dexie merge', async () => {
    const remoteRegistry = createRegistry();
    await remoteRegistry.recordDecision(suggestion(), { kind: 'deferred', deferUntil: 2_000 }, 1_000);
    const malformed = await remoteRegistry.exportSnapshot();
    malformed.decisions = malformed.decisions.map((row) => ({
        ...row,
        deferUntil: 'tomorrow',
    })) as never;
    const store = new FakeRegistryStore();
    store.data = malformed;
    const localRegistry = createRegistry();
    const sync = new SuggestionRegistrySync(localRegistry, store);

    assert.equal((await sync.fetchAndMerge()).kind, 'error');
    assert.equal((await localRegistry.exportSnapshot()).decisions.length, 0);
});

test('multiple registry snapshots merge without compaction when nothing is pending', async () => {
    const firstRegistry = createRegistry();
    await firstRegistry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const secondRegistry = createRegistry();
    await secondRegistry.recordDecision(
        suggestion({ id: 'proposal-b', title: 'Jiný návrh' }),
        { kind: 'accepted' },
        1_100,
    );
    const store = new FakeRegistryStore();
    store.data = await firstRegistry.exportSnapshot();
    store.duplicateData = [await secondRegistry.exportSnapshot()];
    const localRegistry = createRegistry();
    const sync = new SuggestionRegistrySync(localRegistry, store);

    assert.equal((await sync.fetchAndMerge()).kind, 'loaded');

    assert.equal(store.writeCount, 0);
    assert.deepEqual(store.writeCalls, []);
    assert.deepEqual(store.trashedFileIds, []);
    assert.equal((await localRegistry.exportSnapshot()).decisions.length, 2);
});
