/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
    ProtocolContractArtifact,
    ProtocolWireMessage,
} from './contracts.ts';
import {
    calculateEd25519PublicKeyFingerprint,
    canonicalizeProtocolJson,
    createDetachedSignature,
} from './validation.ts';
import {
    createFullU1DriveMessageVerifier,
    DRIVE_PROTOCOL_PROPERTIES,
    DriveTransportError,
    ImmutableDriveTransport,
    LocalStorageDriveBindingCache,
    LocalStorageDriveCursorStore,
    type DriveProtocolApi,
    type DriveProtocolChangePage,
    type DriveProtocolFileMetadata,
    type DriveProtocolFilePage,
    type DriveTransportCursorStore,
    type DriveWorkspaceBinding,
    type FullU1DriveMessageVerifier,
} from './driveTransport.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const protocolRoot = path.resolve(moduleDir, '../../../../docs/agent-protocol/v2');

const trustedArtifact: ProtocolContractArtifact = {
    id: 'battleplan-hermes-protocol',
    version: '2.0.0',
    sha256: 'sha256:fa0496524c56796ff8eec77f5ccd013b4b6d404836d673b1cb8dcc70ae96d7d7',
};

async function createTestSigningContext() {
    const keys = await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify'],
    ) as CryptoKeyPair;
    const rawPublicKeyBytes = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keys.publicKey));
    const rawPublicKey = Buffer.from(rawPublicKeyBytes).toString('base64url');
    return {
        keys,
        rawPublicKey,
        fingerprint: calculateEd25519PublicKeyFingerprint(rawPublicKeyBytes),
    };
}

const testSigningContext = createTestSigningContext();

async function canonicalFixture(name = 'hello'): Promise<string> {
    const context = await testSigningContext;
    const fixture = JSON.parse(
        await readFile(path.join(protocolRoot, `fixtures/valid/${name}.json`), 'utf8'),
    ) as ProtocolWireMessage;
    fixture.signed.signing_key_id = 'ed25519:transport-test';
    fixture.signed.pairing_epoch = 1;
    if (fixture.signed.message_type === 'hello') {
        fixture.signed.payload.public_key.key_id = fixture.signed.signing_key_id;
        fixture.signed.payload.public_key.pairing_epoch = fixture.signed.pairing_epoch;
        fixture.signed.payload.public_key.raw_public_key = context.rawPublicKey;
        fixture.signed.payload.public_key.fingerprint = context.fingerprint;
    }
    fixture.signature = await createDetachedSignature(fixture.signed, context.keys.privateKey);
    return canonicalizeProtocolJson(fixture);
}

const fullU1Verifier: FullU1DriveMessageVerifier = createFullU1DriveMessageVerifier(async (message) => {
    const context = await testSigningContext;
    return {
        trustedPairing: {
            status: 'active',
            workspaceId: message.signed.workspace_id,
            producerId: message.signed.producer_id,
            targetId: message.signed.target.id,
            keyId: message.signed.signing_key_id,
            pairingEpoch: message.signed.pairing_epoch,
            rawPublicKey: context.rawPublicKey,
            fingerprint: context.fingerprint,
        },
        trustedContractArtifact: trustedArtifact,
        now: new Date('2026-08-09T10:05:00.000Z'),
    };
});

const binding: DriveWorkspaceBinding = {
    accountId: 'user@example.com',
    folderId: 'folder-protocol-v2',
    folderName: 'BattlePlan-Hermes-v2',
    expectedParentId: 'root',
    authority: { kind: 'owner', ownerPermissionId: 'owner-permission-1' },
    workspaceId: '018f6f5e-2d88-7f2a-8f90-d6ad23000010',
};

class MemoryCursorStore implements DriveTransportCursorStore {
    value: string | null = null;
    saves: string[] = [];

    async load(): Promise<string | null> {
        return this.value;
    }

    async save(value: string): Promise<void> {
        this.value = value;
        this.saves.push(value);
    }
}

class FakeDriveApi implements DriveProtocolApi {
    files = new Map<string, { metadata: DriveProtocolFileMetadata; body: string }>();
    folderPages: DriveProtocolFilePage[] = [{ files: [], nextPageToken: null, incompleteSearch: false }];
    messagePages: DriveProtocolFilePage[] = [{ files: [], nextPageToken: null, incompleteSearch: false }];
    changePages = new Map<string, DriveProtocolChangePage>();
    generatedIds = ['generated-file-1'];
    createError: unknown = null;
    listMessageCalls: Array<{ pageToken: string | null; folderId: string; workspaceId: string }> = [];
    downloadedIds: string[] = [];
    changeCalls: string[] = [];
    private folderPageIndex = 0;
    private messagePageIndex = 0;

    constructor() {
        this.files.set(binding.folderId, {
            metadata: {
                id: binding.folderId,
                name: binding.folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [binding.expectedParentId],
                trashed: false,
                owners: [{ permissionId: 'owner-permission-1' }],
                properties: {},
                size: null,
                driveId: null,
            },
            body: '',
        });
        this.folderPages = [{
            files: [this.files.get(binding.folderId)!.metadata],
            nextPageToken: null,
            incompleteSearch: false,
        }];
    }

    async getFile(fileId: string): Promise<DriveProtocolFileMetadata> {
        const file = this.files.get(fileId);
        if (!file) throw Object.assign(new Error('not found'), { status: 404 });
        return structuredClone(file.metadata);
    }

    async listFoldersByName(): Promise<DriveProtocolFilePage> {
        return structuredClone(this.folderPages[this.folderPageIndex++] ?? { files: [], nextPageToken: null, incompleteSearch: false });
    }

    async listMessageFiles(input: { folderId: string; workspaceId: string; pageToken: string | null }): Promise<DriveProtocolFilePage> {
        this.listMessageCalls.push(input);
        return structuredClone(this.messagePages[this.messagePageIndex++] ?? { files: [], nextPageToken: null, incompleteSearch: false });
    }

    async generateFileId(): Promise<string> {
        const generated = this.generatedIds.shift();
        if (!generated) throw new Error('no generated ID');
        return generated;
    }

    async createImmutableFile(input: { fileId: string; metadata: DriveProtocolFileMetadata; body: string }): Promise<void> {
        if (this.createError) throw this.createError;
        this.files.set(input.fileId, { metadata: structuredClone(input.metadata), body: input.body });
    }

    async downloadFile(fileId: string): Promise<string> {
        this.downloadedIds.push(fileId);
        const file = this.files.get(fileId);
        if (!file) throw Object.assign(new Error('not found'), { status: 404 });
        return file.body;
    }

    async getStartPageToken(): Promise<string> {
        return 'start-token';
    }

    async listChanges(pageToken: string): Promise<DriveProtocolChangePage> {
        this.changeCalls.push(pageToken);
        const page = this.changePages.get(pageToken);
        if (!page) throw new Error(`missing change page ${pageToken}`);
        return structuredClone(page);
    }
}

function transport(api: FakeDriveApi, cursor = new MemoryCursorStore()): ImmutableDriveTransport {
    return new ImmutableDriveTransport({ api, binding, cursorStore: cursor, verifier: fullU1Verifier });
}

function transportWithSleep(
    api: FakeDriveApi,
    sleep: (delayMs: number) => Promise<void>,
    cursor = new MemoryCursorStore(),
): ImmutableDriveTransport {
    return new ImmutableDriveTransport({ api, binding, cursorStore: cursor, verifier: fullU1Verifier, sleep });
}

test('workspace bootstrap rejects duplicate same-name folders and stale account-scoped binding cache', async () => {
    const api = new FakeDriveApi();
    api.folderPages = [{
        files: [
            api.files.get(binding.folderId)!.metadata,
            { ...api.files.get(binding.folderId)!.metadata, id: 'duplicate-folder' },
        ],
        nextPageToken: null,
        incompleteSearch: false,
    }];

    await assert.rejects(
        () => transport(api).verifyWorkspace(),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'workspace_ambiguous',
    );

    const cleanApi = new FakeDriveApi();
    const cache = {
        load: async () => ({ ...binding, accountId: 'other@example.com' }),
        save: async () => assert.fail('stale binding must not be overwritten'),
    };
    const withStaleCache = new ImmutableDriveTransport({
        api: cleanApi,
        binding,
        cursorStore: new MemoryCursorStore(),
        bindingCache: cache,
        verifier: fullU1Verifier,
    });
    await assert.rejects(
        () => withStaleCache.verifyWorkspace(),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'stale_binding_cache',
    );
});

test('prepared immutable upload treats a verified 409 replay as success', async () => {
    const api = new FakeDriveApi();
    const client = transport(api);
    const prepared = await client.prepare(await canonicalFixture());
    api.files.set(prepared.fileId, { metadata: structuredClone(prepared.metadata), body: prepared.body });
    api.createError = Object.assign(new Error('already exists'), { status: 409 });

    assert.deepEqual(await client.publish(prepared), {
        kind: 'published',
        fileId: prepared.fileId,
        replayed: true,
    });
    assert.equal(api.downloadedIds.at(-1), prepared.fileId);
});

test('409 replay fails closed when immutable bytes or metadata differ', async () => {
    const api = new FakeDriveApi();
    const client = transport(api);
    const prepared = await client.prepare(await canonicalFixture());
    api.files.set(prepared.fileId, {
        metadata: { ...structuredClone(prepared.metadata), parents: ['wrong-folder'] },
        body: prepared.body,
    });
    api.createError = Object.assign(new Error('already exists'), { status: 409 });

    await assert.rejects(
        () => client.publish(prepared),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'immutable_file_conflict',
    );
});

test('publish rejects a corrupted durable prepared record before any create request', async () => {
    const api = new FakeDriveApi();
    const client = transport(api);
    const prepared = await client.prepare(await canonicalFixture());
    prepared.metadata.properties.bpv2_message_id = 'different-message';
    let createCalls = 0;
    api.createImmutableFile = async () => { createCalls += 1; };

    await assert.rejects(
        () => client.publish(prepared),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'immutable_file_conflict',
    );
    assert.equal(createCalls, 0);
});

test('persisted preparation seal rejects simultaneous replacement of fileId and metadata.id', async () => {
    const api = new FakeDriveApi();
    const client = transport(api);
    const prepared = await client.prepare(await canonicalFixture());
    prepared.fileId = 'replacement-file-id';
    prepared.metadata.id = 'replacement-file-id';
    let createCalls = 0;
    api.createImmutableFile = async () => { createCalls += 1; };

    await assert.rejects(
        () => client.publish(prepared),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'immutable_file_conflict',
    );
    assert.equal(createCalls, 0);
});

test('publish snapshots the prepared record before an async workspace verification can race caller mutation', async () => {
    const api = new FakeDriveApi();
    const client = transport(api);
    const prepared = await client.prepare(await canonicalFixture());
    const originalFileId = prepared.fileId;
    let markWorkspaceLookupStarted!: () => void;
    let releaseWorkspaceLookup!: () => void;
    const workspaceLookupStarted = new Promise<void>((resolve) => { markWorkspaceLookupStarted = resolve; });
    const workspaceLookupGate = new Promise<void>((resolve) => { releaseWorkspaceLookup = resolve; });
    api.listFoldersByName = async () => {
        markWorkspaceLookupStarted();
        await workspaceLookupGate;
        return {
            files: [structuredClone(api.files.get(binding.folderId)!.metadata)],
            nextPageToken: null,
            incompleteSearch: false,
        };
    };
    const createdIds: string[] = [];
    api.createImmutableFile = async (input) => {
        createdIds.push(input.fileId);
        assert.equal(input.metadata.id, originalFileId);
        api.files.set(input.fileId, { metadata: structuredClone(input.metadata), body: input.body });
    };

    const publishing = client.publish(prepared);
    await workspaceLookupStarted;
    prepared.fileId = 'attacker-raced-id';
    prepared.metadata.id = 'attacker-raced-id';
    releaseWorkspaceLookup();

    assert.deepEqual(await publishing, {
        kind: 'published',
        fileId: originalFileId,
        replayed: false,
    });
    assert.deepEqual(createdIds, [originalFileId]);
    assert.equal(api.files.has('attacker-raced-id'), false);
});

test('constructor rejects a structural-only verifier that did not come from the full-U1 factory', () => {
    const api = new FakeDriveApi();
    const structuralOnly = {
        verify: async () => assert.fail('structural-only verifier must never be invoked'),
    } as unknown as FullU1DriveMessageVerifier;

    assert.throws(
        () => new ImmutableDriveTransport({
            api,
            binding,
            cursorStore: new MemoryCursorStore(),
            verifier: structuralOnly,
        }),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'verification_failed',
    );
});

test('folder scan consumes every page and verifies body-backed public properties', async () => {
    const api = new FakeDriveApi();
    const client = transport(api);
    const first = await client.prepare(await canonicalFixture('hello'));
    api.generatedIds.push('generated-file-2');
    const second = await client.prepare(await canonicalFixture('proposal'));
    api.files.set(first.fileId, { metadata: first.metadata, body: first.body });
    api.files.set(second.fileId, { metadata: second.metadata, body: second.body });
    api.messagePages = [
        { files: [first.metadata], nextPageToken: 'page-2', incompleteSearch: false },
        { files: [second.metadata], nextPageToken: null, incompleteSearch: false },
    ];
    const consumed: string[] = [];

    await client.scanAll(async (message) => {
        consumed.push(message.message.signed.message_id);
    });

    assert.equal(consumed.length, 2);
    assert.deepEqual(api.listMessageCalls.map((call) => call.pageToken), [null, 'page-2']);
    assert.ok(api.listMessageCalls.every((call) => call.folderId === binding.folderId && call.workspaceId === binding.workspaceId));
});

test('incomplete Drive search fails without accepting arbitrary list order', async () => {
    const api = new FakeDriveApi();
    api.messagePages = [{ files: [], nextPageToken: null, incompleteSearch: true }];

    await assert.rejects(
        () => transport(api).scanAll(async () => {}),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'incomplete_search',
    );
});

test('bootstrap captures start token before scan, deduplicates replay, and saves only the final token', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    api.files.set(prepared.fileId, { metadata: prepared.metadata, body: prepared.body });
    api.messagePages = [{ files: [prepared.metadata], nextPageToken: null, incompleteSearch: false }];
    api.changePages.set('start-token', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: 'change-page-2',
        newStartPageToken: null,
    });
    api.changePages.set('change-page-2', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'final-token',
    });
    const consumed: string[] = [];

    await client.bootstrap(async (message) => {
        consumed.push(message.fileId);
    });

    assert.deepEqual(consumed, [prepared.fileId]);
    assert.deepEqual(cursor.saves, ['final-token']);
});

test('poll does not advance a durable cursor when verification or consumption fails', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    const malformed = '{"not":"a protocol message"}';
    api.files.set(prepared.fileId, {
        metadata: { ...prepared.metadata, size: String(new TextEncoder().encode(malformed).byteLength) },
        body: malformed,
    });
    api.changePages.set('cursor-1', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });
    await assert.rejects(
        () => client.poll(async () => assert.fail('malformed messages must not be delivered')),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'malformed_message',
    );
    assert.equal(cursor.value, 'cursor-1');
    assert.deepEqual(cursor.saves, []);
});

test('full-U1 transport verifier rejects a schema-valid message with an invalid signature', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const invalid = JSON.parse(await canonicalFixture()) as ProtocolWireMessage;
    invalid.signature.value = 'AA';
    const prepared = await client.prepare(canonicalizeProtocolJson(invalid));
    api.files.set(prepared.fileId, { metadata: prepared.metadata, body: prepared.body });
    api.changePages.set('cursor-1', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });

    await assert.rejects(
        () => client.poll(async () => assert.fail('invalid signatures must not be delivered')),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'verification_failed',
    );
    assert.equal(cursor.value, 'cursor-1');
    assert.deepEqual(cursor.saves, []);
});

test('signature_missing is classified as verification_failed and leaves the cursor unchanged', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    const missingSignature = JSON.parse(prepared.body) as Partial<ProtocolWireMessage>;
    delete missingSignature.signature;
    const body = canonicalizeProtocolJson(missingSignature);
    api.files.set(prepared.fileId, {
        metadata: { ...prepared.metadata, size: String(new TextEncoder().encode(body).byteLength) },
        body,
    });
    api.changePages.set('cursor-1', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });

    await assert.rejects(
        () => client.poll(async () => assert.fail('unsigned messages must not be delivered')),
        (error: unknown) => error instanceof DriveTransportError
            && error.code === 'verification_failed'
            && error.message.startsWith('signature_missing:'),
    );
    assert.equal(cursor.value, 'cursor-1');
    assert.deepEqual(cursor.saves, []);
});

test('quota/auth/missing failures stay distinguishable and never collapse into success', async () => {
    const cases = [
        { status: 401, code: 'authorization_failed' },
        { status: 404, code: 'missing_file' },
        { status: 429, code: 'rate_limited' },
        { status: 503, code: 'transport_retryable' },
    ] as const;
    for (const expected of cases) {
        const api = new FakeDriveApi();
        const client = transportWithSleep(api, async () => {});
        const prepared = await client.prepare(await canonicalFixture());
        api.createError = Object.assign(new Error(`HTTP ${expected.status}`), { status: expected.status });
        await assert.rejects(
            () => client.publish(prepared),
            (error: unknown) => error instanceof DriveTransportError && error.code === expected.code,
            String(expected.status),
        );
    }
});

test('publish retries 429 and network failures at most three times with the same prepared Drive ID', async () => {
    const api = new FakeDriveApi();
    const delays: number[] = [];
    const client = transportWithSleep(api, async (delayMs) => { delays.push(delayMs); });
    const prepared = await client.prepare(await canonicalFixture());
    const attemptedIds: string[] = [];
    const failures = [
        Object.assign(new Error('rate limited'), { status: 429 }),
        new TypeError('network disconnected'),
    ];
    api.createImmutableFile = async (input) => {
        attemptedIds.push(input.fileId);
        const failure = failures.shift();
        if (failure) throw failure;
        api.files.set(input.fileId, { metadata: structuredClone(input.metadata), body: input.body });
    };

    assert.deepEqual(await client.publish(prepared), {
        kind: 'published', fileId: prepared.fileId, replayed: false,
    });
    assert.deepEqual(attemptedIds, [prepared.fileId, prepared.fileId, prepared.fileId]);
    assert.deepEqual(delays, [500, 1_000]);
});

test('ambiguous 5xx create verifies the reserved ID before retrying create', async () => {
    const api = new FakeDriveApi();
    const delays: number[] = [];
    const client = transportWithSleep(api, async (delayMs) => { delays.push(delayMs); });
    const prepared = await client.prepare(await canonicalFixture());
    let createCalls = 0;
    api.createImmutableFile = async (input) => {
        createCalls += 1;
        api.files.set(input.fileId, { metadata: structuredClone(input.metadata), body: input.body });
        throw Object.assign(new Error('server response lost'), { status: 503 });
    };

    assert.deepEqual(await client.publish(prepared), {
        kind: 'published', fileId: prepared.fileId, replayed: true,
    });
    assert.equal(createCalls, 1);
    assert.deepEqual(delays, []);
});

test('exhausted change-page retries keep the durable cursor unchanged', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const delays: number[] = [];
    const client = transportWithSleep(api, async (delayMs) => { delays.push(delayMs); }, cursor);
    let changeCalls = 0;
    api.listChanges = async () => {
        changeCalls += 1;
        throw Object.assign(new Error('Drive unavailable'), { status: 503 });
    };

    await assert.rejects(
        () => client.poll(async () => assert.fail('no change can be delivered')),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'transport_retryable',
    );
    assert.equal(changeCalls, 3);
    assert.deepEqual(delays, [500, 1_000]);
    assert.equal(cursor.value, 'cursor-1');
    assert.deepEqual(cursor.saves, []);
});

test('overlapping poll triggers join one in-flight change consumption', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    api.files.set(prepared.fileId, { metadata: prepared.metadata, body: prepared.body });
    api.changePages.set('cursor-1', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let deliveries = 0;
    const consume = async () => {
        deliveries += 1;
        await gate;
    };

    const first = client.poll(consume);
    const second = client.poll(consume);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);

    assert.equal(deliveries, 1);
    assert.deepEqual(api.changeCalls, ['cursor-1']);
    assert.deepEqual(cursor.saves, ['cursor-2']);
});

test('public scanAll serializes with poll through the shared synchronization coordinator', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    api.files.set(prepared.fileId, { metadata: prepared.metadata, body: prepared.body });
    api.changePages.set('cursor-1', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });
    api.listFoldersByName = async () => ({
        files: [structuredClone(api.files.get(binding.folderId)!.metadata)],
        nextPageToken: null,
        incompleteSearch: false,
    });
    let releaseScan!: () => void;
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => { markScanStarted = resolve; });
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    api.listMessageFiles = async (input) => {
        api.listMessageCalls.push(input);
        markScanStarted();
        await scanGate;
        return { files: [], nextPageToken: null, incompleteSearch: false };
    };
    const delivered: string[] = [];

    const scan = client.scanAll(async () => assert.fail('empty scan must not deliver'));
    await scanStarted;
    const poll = client.poll(async (message) => { delivered.push(message.fileId); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(api.changeCalls, [], 'poll must not overlap the active scan');
    releaseScan();
    await Promise.all([scan, poll]);

    assert.deepEqual(delivered, [prepared.fileId]);
    assert.deepEqual(api.changeCalls, ['cursor-1']);
    assert.deepEqual(cursor.saves, ['cursor-2']);
});

test('browser stores scope durable binding and cursor state by account and workspace', async () => {
    const values = new Map<string, string>();
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const cursor = new LocalStorageDriveCursorStore(storage, binding);
    const cache = new LocalStorageDriveBindingCache(storage, binding);
    await cursor.save('cursor-durable');
    await cache.save(binding);

    assert.equal(await new LocalStorageDriveCursorStore(storage, binding).load(), 'cursor-durable');
    assert.deepEqual(await new LocalStorageDriveBindingCache(storage, binding).load(), binding);
    assert.equal(await new LocalStorageDriveCursorStore(storage, { ...binding, accountId: 'other@example.com' }).load(), null);
});

test('a durable consumer failure leaves the current change page unadvanced', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    api.files.set(prepared.fileId, { metadata: prepared.metadata, body: prepared.body });
    api.changePages.set('cursor-1', {
        changes: [{ fileId: prepared.fileId, removed: false, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });

    await assert.rejects(() => client.poll(async () => { throw new Error('durable commit failed'); }), /durable commit failed/);
    assert.equal(cursor.value, 'cursor-1');
    assert.deepEqual(cursor.saves, []);
});

test('a relevant immutable-file tombstone is not silently skipped or checkpointed', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    api.changePages.set('cursor-1', {
        changes: [{ fileId: prepared.fileId, removed: true, file: prepared.metadata }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });

    await assert.rejects(
        () => client.poll(async () => assert.fail('removed messages cannot be delivered')),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'missing_file',
    );
    assert.equal(cursor.value, 'cursor-1');
});

test('a relevant trashed=true tombstone is not skipped when Drive removed is false', async () => {
    const api = new FakeDriveApi();
    const cursor = new MemoryCursorStore();
    cursor.value = 'cursor-1';
    const client = transport(api, cursor);
    const prepared = await client.prepare(await canonicalFixture());
    api.changePages.set('cursor-1', {
        changes: [{
            fileId: prepared.fileId,
            removed: false,
            file: { ...prepared.metadata, trashed: true },
        }],
        nextPageToken: null,
        newStartPageToken: 'cursor-2',
    });

    await assert.rejects(
        () => client.poll(async () => assert.fail('trashed messages cannot be delivered')),
        (error: unknown) => error instanceof DriveTransportError && error.code === 'missing_file',
    );
    assert.equal(cursor.value, 'cursor-1');
    assert.deepEqual(cursor.saves, []);
});

test('normative Drive transport documentation contains every implemented property and stable outcome', async () => {
    const documentation = await readFile(path.join(protocolRoot, 'DRIVE_TRANSPORT.md'), 'utf8');
    assert.match(documentation, /drive-immutable-v2/);
    for (const property of Object.values(DRIVE_PROTOCOL_PROPERTIES)) {
        assert.match(documentation, new RegExp(`\\b${property}\\b`), property);
    }
    for (const code of [
        'authorization_failed', 'rate_limited', 'transport_retryable', 'workspace_missing',
        'workspace_ambiguous', 'workspace_parent_mismatch', 'workspace_authority_mismatch',
        'incomplete_search', 'missing_file', 'malformed_message', 'unsupported_message',
        'verification_failed', 'metadata_mismatch', 'immutable_file_conflict',
    ]) {
        assert.match(documentation, new RegExp(`\\b${code}\\b`), code);
    }
    assert.match(documentation, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
    assert.match(documentation, /three attempts with 500 ms then 1,000 ms backoff/);
    assert.match(documentation, /BattlePlan-Hermes\/drive-prepared\/v2/);
    assert.match(documentation, /full-U1 verifier factory/);
    assert.match(documentation, /scanAll\(\).*shared synchronization coordinator/);
    assert.match(documentation, /trashed=true/);
    assert.match(documentation, /synchronous entry to `publish`, before its first asynchronous boundary/);
});
