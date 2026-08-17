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

const databases: BattlePlanDB[] = [];

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
    rejectNextWriteAsStale = false;
    staleReplacementData: SuggestionRegistryFile | null = null;
    etag = '"registry-etag-a"';
    omitEtag = false;

    async init(): Promise<boolean> {
        return this.initialized;
    }

    async readJsonFilesWithStatus<T>(): Promise<
        | { kind: 'loaded'; files: Array<{ fileId: string; etag?: string; data: T }> }
        | { kind: 'missing-file' }
    > {
        this.readCount++;
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
        if (this.rejectNextWriteAsStale) {
            this.rejectNextWriteAsStale = false;
            if (this.staleReplacementData) {
                this.data = structuredClone(this.staleReplacementData);
                this.etag = '"registry-etag-b"';
            }
            throw Object.assign(new Error('stale Drive revision'), { status: 412 });
        }
        if (this.dropNextWrite) {
            this.dropNextWrite = false;
        } else {
            this.data = structuredClone(payload) as SuggestionRegistryFile;
        }
        return { fileId: 'registry-a' };
    }

    async trashFile(fileId: string): Promise<void> {
        this.trashedFileIds.push(fileId);
        const index = fileId.charCodeAt(fileId.length - 1) - 98;
        if (index >= 0) this.duplicateData.splice(index, 1);
    }
}

test('publishing verifies the journal and retries a lost whole-file write', async () => {
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

test('publishing retries after Drive rejects a stale conditional revision', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const initialRemote = createRegistry();
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
    store.data = await initialRemote.exportSnapshot();
    store.rejectNextWriteAsStale = true;
    store.staleReplacementData = await concurrentRemote.exportSnapshot();
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.equal(result.kind, 'published');
    assert.equal(store.writeCount, 2);
    assert.equal(store.readCount, 3);
    assert.deepEqual(store.writeCalls, [
        { fileId: 'registry-a', options: { ifMatch: '"registry-etag-a"' } },
        { fileId: 'registry-a', options: { ifMatch: '"registry-etag-b"' } },
    ]);
    assert.ok(store.data?.decisions.some((row) => row.id === decision.id));
    assert.ok(store.data?.decisions.some((row) => row.suggestionId === 'proposal-remote'));
});

test('publishing fails closed when an existing registry has no ETag', async () => {
    const registry = createRegistry();
    const decision = await registry.recordDecision(suggestion(), { kind: 'rejected' }, 1_000);
    const emptyRegistry = createRegistry();
    const store = new FakeRegistryStore();
    store.data = await emptyRegistry.exportSnapshot();
    store.omitEtag = true;
    const sync = new SuggestionRegistrySync(registry, store);

    const result = await sync.publishPending();

    assert.equal(result.kind, 'error');
    assert.equal(store.writeCount, 0);
    assert.equal((await registry.exportSnapshot()).decisions.find((row) => row.id === decision.id)?.publishedAt, undefined);
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

test('duplicate first-use registry files converge into one canonical journal', async () => {
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

    assert.equal(store.data.decisions.length, 2);
    assert.deepEqual(store.writeCalls, [
        { fileId: 'registry-a', options: { ifMatch: '"registry-etag-a"' } },
    ]);
    assert.deepEqual(store.trashedFileIds, ['registry-b']);
    assert.equal((await localRegistry.exportSnapshot()).decisions.length, 2);
});
