/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ProtocolValidationResult } from './contracts.ts';
import { canonicalizeProtocolJson, validateProtocolWireMessage } from './validation.ts';
import {
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
} from './driveTransport.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const protocolRoot = path.resolve(moduleDir, '../../../../docs/agent-protocol/v2');

async function canonicalFixture(name = 'hello'): Promise<string> {
    const fixture = JSON.parse(await readFile(path.join(protocolRoot, `fixtures/valid/${name}.json`), 'utf8')) as unknown;
    return canonicalizeProtocolJson(fixture);
}

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

function verifier(raw: string): Promise<ProtocolValidationResult> {
    return Promise.resolve(validateProtocolWireMessage(raw));
}

function transport(api: FakeDriveApi, cursor = new MemoryCursorStore()): ImmutableDriveTransport {
    return new ImmutableDriveTransport({ api, binding, cursorStore: cursor, verifyMessage: verifier });
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
        verifyMessage: verifier,
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

test('quota/auth/missing failures stay distinguishable and never collapse into success', async () => {
    const cases = [
        { status: 401, code: 'authorization_failed' },
        { status: 404, code: 'missing_file' },
        { status: 429, code: 'rate_limited' },
        { status: 503, code: 'transport_retryable' },
    ] as const;
    for (const expected of cases) {
        const api = new FakeDriveApi();
        const client = transport(api);
        const prepared = await client.prepare(await canonicalFixture());
        api.createError = Object.assign(new Error(`HTTP ${expected.status}`), { status: expected.status });
        await assert.rejects(
            () => client.publish(prepared),
            (error: unknown) => error instanceof DriveTransportError && error.code === expected.code,
            String(expected.status),
        );
    }
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
});
