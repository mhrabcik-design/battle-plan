/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

interface MockLocalStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    clear: () => void;
}

interface MockWindow {
    gapi?: unknown;
    google?: unknown;
    localStorage: MockLocalStorage;
    dispatchEvent?: (e: Event) => boolean;
    addEventListener?: (...args: unknown[]) => void;
    removeEventListener?: (...args: unknown[]) => void;
}

const defaultStorage = new Map<string, string>();
const defaultLocalStorage: MockLocalStorage = {
    getItem: (key) => defaultStorage.get(key) ?? null,
    setItem: (key, value) => { defaultStorage.set(key, value); },
    removeItem: (key) => { defaultStorage.delete(key); },
    clear: () => { defaultStorage.clear(); },
};

const defaultWindow: MockWindow = {
    localStorage: defaultLocalStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
};

(globalThis as unknown as { window: MockWindow }).window = defaultWindow;
(globalThis as unknown as { localStorage: MockLocalStorage }).localStorage = defaultLocalStorage;

const {
    buildDriveFileMetadata,
    buildMultipartJsonBody,
    buildMultipartRawJsonBody,
    DriveJsonStore,
    GapiDriveProtocolApi,
    getUploadedDriveFileId,
} = await import('./driveJsonStore.ts');
const { AuthUnavailableError, googleService } = await import('./googleService.ts');

type GoogleServiceInternalState = {
    accessToken: string | null;
    expiresAt: number;
    userEmail: string | null;
    trySilentRefresh: () => Promise<boolean>;
    getAuthState: () => string;
    getAuthStatus: () => { state: string; accessToken: string | null };
};

function installDriveGlobals(client: unknown, initialStorage: Record<string, string> = {}): MockWindow {
    const storage = new Map<string, string>(Object.entries(initialStorage));
    const localStorage: MockLocalStorage = {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => { storage.set(key, value); },
        removeItem: (key) => { storage.delete(key); },
        clear: () => { storage.clear(); },
    };
    const mockWindow: MockWindow = {
        gapi: { client },
        google: defaultWindow.google,
        localStorage,
        dispatchEvent: defaultWindow.dispatchEvent,
        addEventListener: defaultWindow.addEventListener,
        removeEventListener: defaultWindow.removeEventListener,
    };
    const globals = globalThis as unknown as { window: MockWindow; localStorage: MockLocalStorage };
    globals.window = mockWindow;
    globals.localStorage = localStorage;
    return mockWindow;
}

function setGoogleServiceState(state: {
    accessToken?: string | null;
    expiresAt?: number;
    userEmail?: string | null;
}): void {
    const svc = googleService as unknown as GoogleServiceInternalState;
    if (state.accessToken !== undefined) svc.accessToken = state.accessToken;
    if (state.expiresAt !== undefined) svc.expiresAt = state.expiresAt;
    if (state.userEmail !== undefined) svc.userEmail = state.userEmail;
}

test('buildDriveFileMetadata puts a new file into the BattlePlan Drive folder', () => {
    assert.deepEqual(
        buildDriveFileMetadata('data.json', 'application/json', 'folder-123', null),
        {
            name: 'data.json',
            mimeType: 'application/json',
            parents: ['folder-123'],
        },
    );
});

test('buildDriveFileMetadata does not move existing Drive files on update', () => {
    assert.deepEqual(
        buildDriveFileMetadata('data.json', 'application/json', 'folder-123', 'file-456'),
        {
            name: 'data.json',
            mimeType: 'application/json',
        },
    );
});

test('getUploadedDriveFileId reads ids from gapi result or response body', () => {
    assert.equal(getUploadedDriveFileId({ result: { id: 'from-result' } }), 'from-result');
    assert.equal(getUploadedDriveFileId({ body: JSON.stringify({ id: 'from-body' }) }), 'from-body');
    assert.equal(getUploadedDriveFileId({ body: '{not json' }), null);
});

test('buildMultipartJsonBody contains metadata and payload without auth material', () => {
    const body = buildMultipartJsonBody(
        buildDriveFileMetadata('data.json', 'application/json', 'folder-123', null),
        { hello: 'world' },
        'boundary-test',
    );

    assert.match(body, /boundary-test/);
    assert.match(body, /"name":"data\.json"/);
    assert.match(body, /"parents":\["folder-123"\]/);
    assert.match(body, /"hello":"world"/);
    assert.doesNotMatch(body, /Bearer|google_access_token|access_token/i);
});

test('DriveJsonStore escapes Drive query values and rejects failed uploads', async () => {
    const queries: string[] = [];
    installDriveGlobals({
        drive: {
            files: {
                list: async (args: { q: string }) => {
                    queries.push(args.q);
                    return { result: { files: [{ id: 'file-123', name: 'data.json' }] } };
                },
            },
        },
        request: async () => ({ status: 500, statusText: 'Nope' }),
    }, {
        bp_folder_id: "folder'\\id",
        google_access_token: 'token-123',
    });

    setGoogleServiceState({
        accessToken: 'token-123',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const store = new DriveJsonStore();
    assert.equal(await store.init(), true);

    await assert.rejects(
        () => store.writeJsonFile("data's.json", { hello: 'world' }),
        /Drive JSON upload failed: 500 Nope/,
    );
    assert.match(queries[0], /name='data\\'s\.json'/);
    assert.match(queries[0], /'folder\\'\\\\id' in parents/);
});

test('DriveJsonStore sends an If-Match precondition for conditional journal updates', async () => {
    const requestHeaders: Array<Record<string, string>> = [];
    installDriveGlobals({
        drive: { files: { list: async () => ({ result: { files: [] } }) } },
        request: async (args: { headers: Record<string, string> }) => {
            requestHeaders.push(args.headers);
            return { status: 200, result: { id: 'file-123' }, headers: { ETag: '"etag-8"' } };
        },
    }, {
        bp_folder_id: 'folder-123',
        google_access_token: 'token-123',
    });
    setGoogleServiceState({
        accessToken: 'token-123',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });
    const store = new DriveJsonStore();
    assert.equal(await store.init(), true);

    const result = await store.writeJsonFile('data.json', { hello: 'world' }, 'file-123', { ifMatch: '"etag-7"' });

    assert.equal(requestHeaders[0]['If-Match'], '"etag-7"');
    assert.equal(result?.etag, '"etag-8"');
});

test('DriveJsonStore lists every duplicate JSON page deterministically and trashes an exact id', async () => {
    const listArguments: Array<{ pageSize?: number; pageToken?: string }> = [];
    const requests: Array<{ path: string; method: string; body: string }> = [];
    installDriveGlobals({
        drive: {
            files: {
                list: async (args: { pageSize?: number; pageToken?: string }) => {
                    listArguments.push(args);
                    return args.pageToken
                        ? { result: { files: [{ id: 'file-m' }] } }
                        : { result: { files: [{ id: 'file-z' }, { id: 'file-a' }], nextPageToken: 'page-2' } };
                },
            },
        },
        request: async (args: { path: string; method: string; body: string }) => {
            requests.push(args);
            return { status: 200, result: { id: 'file-a' } };
        },
    }, {
        bp_folder_id: 'folder-123',
        google_access_token: 'token-123',
    });
    setGoogleServiceState({
        accessToken: 'token-123',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });
    const store = new DriveJsonStore();
    assert.equal(await store.init(), true);

    assert.deepEqual(await store.findFileIds('journal.json'), ['file-a', 'file-m', 'file-z']);
    assert.deepEqual(listArguments, [
        { q: "name='journal.json' and 'folder-123' in parents and trashed=false", spaces: 'drive', fields: 'files(id, name), nextPageToken', pageSize: 1000 },
        { q: "name='journal.json' and 'folder-123' in parents and trashed=false", spaces: 'drive', fields: 'files(id, name), nextPageToken', pageSize: 1000, pageToken: 'page-2' },
    ]);
    await store.trashFile('file/z');
    assert.equal(requests[0].path, '/drive/v3/files/file%2Fz?supportsAllDrives=true');
    assert.equal(requests[0].method, 'PATCH');
    assert.equal(requests[0].body, JSON.stringify({ trashed: true }));
});

test('DriveJsonStore accepts created folder ids from gapi result payloads', async () => {
    const createdFolders: string[] = [];
    installDriveGlobals({
        drive: {
            files: {
                list: async () => ({ result: { files: [] } }),
            },
        },
        request: async (args: { body: string }) => {
            const payload = JSON.parse(args.body) as { name?: string };
            if (payload.name) {
                createdFolders.push(payload.name);
            }
            return { status: 200, result: { id: 'folder-created' } };
        },
    }, {
        google_access_token: 'token-123',
    });

    setGoogleServiceState({
        accessToken: 'token-123',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const store = new DriveJsonStore();
    assert.equal(await store.init({ createFolder: true }), true);
    assert.equal(store.currentFolderId, 'folder-created');
    assert.deepEqual(createdFolders, ['Anu-BattlePlan']);
});

test('U4: fresh token (state SIGNED_IN) — getAccessToken returns the live token without calling trySilentRefresh', async () => {
    installDriveGlobals({
        drive: {
            files: {
                list: async () => ({ result: { files: [{ id: 'folder-existing', name: 'Anu-BattlePlan' }] } }),
            },
        },
        request: async () => ({ status: 200, result: { id: 'file-existing' } }),
    }, { bp_folder_id: 'folder-existing' });

    setGoogleServiceState({
        accessToken: 'fresh-live-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const svc = googleService as unknown as GoogleServiceInternalState;
    let refreshCalls = 0;
    svc.trySilentRefresh = async () => { refreshCalls++; return true; };

    const store = new DriveJsonStore();
    assert.equal(await store.init(), true);
    const writeResult = await store.writeJsonFile('data.json', { hello: 'world' });
    assert.ok(writeResult, 'writeJsonFile should succeed when a fresh token is in googleService');

    assert.equal(refreshCalls, 0, 'trySilentRefresh must not be invoked when state is SIGNED_IN');
});

test('U4: expired token (state REFRESH_PENDING), refresh succeeds — getAccessToken returns the new token', async () => {
    installDriveGlobals({
        drive: {
            files: {
                list: async () => ({ result: { files: [{ id: 'folder-existing', name: 'Anu-BattlePlan' }] } }),
            },
        },
        request: async () => ({ status: 200, result: { id: 'file-existing' } }),
    }, { bp_folder_id: 'folder-existing' });

    setGoogleServiceState({
        accessToken: 'expired-token',
        expiresAt: Date.now() - 5 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const svc = googleService as unknown as GoogleServiceInternalState;
    let refreshCalls = 0;
    svc.trySilentRefresh = async function (this: GoogleServiceInternalState) {
        refreshCalls++;
        this.accessToken = 'refreshed-live-token';
        this.expiresAt = Date.now() + 60 * 60 * 1000;
        return true;
    };

    const store = new DriveJsonStore();
    assert.equal(await store.init(), true);
    const writeResult = await store.writeJsonFile('data.json', { hello: 'world' });
    assert.ok(writeResult, 'writeJsonFile should succeed after successful silent refresh');

    assert.equal(refreshCalls, 1, 'trySilentRefresh must be invoked exactly once when state is REFRESH_PENDING');
});

test('concurrent Drive initialization shares one silent refresh flight', async () => {
    installDriveGlobals({
        drive: {
            files: {
                list: async () => ({ result: { files: [{ id: 'folder-existing', name: 'Anu-BattlePlan' }] } }),
            },
        },
    }, { bp_folder_id: 'folder-existing' });

    setGoogleServiceState({
        accessToken: 'expired-token',
        expiresAt: Date.now() - 5 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const svc = googleService as unknown as GoogleServiceInternalState;
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    svc.trySilentRefresh = async function (this: GoogleServiceInternalState) {
        refreshCalls++;
        await refreshPending;
        this.accessToken = 'refreshed-live-token';
        this.expiresAt = Date.now() + 60 * 60 * 1000;
        return true;
    };

    const initResults = [new DriveJsonStore().init(), new DriveJsonStore().init()];
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRefresh();

    assert.deepEqual(await Promise.all(initResults), [true, true]);
    assert.equal(refreshCalls, 1, 'Drive consumers must share googleService.runRefresh()');
});

test('U4: expired token, refresh fails — init returns false (graceful failure)', async () => {
    installDriveGlobals({
        drive: {
            files: {
                list: async () => ({ result: { files: [{ id: 'folder-existing', name: 'Anu-BattlePlan' }] } }),
            },
        },
    }, { bp_folder_id: 'folder-existing' });

    setGoogleServiceState({
        accessToken: 'expired-token',
        expiresAt: Date.now() - 5 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const svc = googleService as unknown as GoogleServiceInternalState;
    svc.trySilentRefresh = async () => false;

    const store = new DriveJsonStore();
    assert.equal(await store.init(), false, 'init returns false when refresh fails');
});

test('U4: readJsonFile — REFRESH_PENDING + refresh failure throws AuthUnavailableError', async () => {
    installDriveGlobals({
        drive: {
            files: {
                list: async (args: { q: string }) => {
                    if (args.q.includes('Anu-BattlePlan')) {
                        return { result: { files: [{ id: 'folder-existing', name: 'Anu-BattlePlan' }] } };
                    }
                    return { result: { files: [{ id: 'file-existing', name: 'data.json' }] } };
                },
            },
        },
    }, { bp_folder_id: 'folder-existing' });

    setGoogleServiceState({
        accessToken: 'expired-token',
        expiresAt: Date.now() - 5 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const svc = googleService as unknown as GoogleServiceInternalState;
    svc.trySilentRefresh = async () => false;

    const store = new DriveJsonStore();
    (store as unknown as { isInitialized: boolean; folderId: string | null }).isInitialized = true;
    (store as unknown as { isInitialized: boolean; folderId: string | null }).folderId = 'folder-existing';

    await assert.rejects(
        () => store.readJsonFile<{ hello: string }>('data.json'),
        (err: unknown) => err instanceof AuthUnavailableError && (err as { code: string }).code === 'AUTH_UNAVAILABLE',
    );
});

test('U4: state is SIGNED_OUT — init returns false without calling refresh', async () => {
    installDriveGlobals({
        drive: {
            files: {
                list: async () => ({ result: { files: [{ id: 'folder-existing', name: 'Anu-BattlePlan' }] } }),
            },
        },
    }, { bp_folder_id: 'folder-existing' });

    setGoogleServiceState({
        accessToken: null,
        expiresAt: 0,
        userEmail: null,
    });

    const svc = googleService as unknown as GoogleServiceInternalState;
    let refreshCalls = 0;
    svc.trySilentRefresh = async () => { refreshCalls++; return true; };

    const store = new DriveJsonStore();
    assert.equal(await store.init(), false, 'init returns false when state is SIGNED_OUT');
    assert.equal(refreshCalls, 0, 'trySilentRefresh must not be invoked when state is SIGNED_OUT');
});

test('U4: AuthUnavailableError is importable from googleService and has the right shape', () => {
    const err = new AuthUnavailableError('Přihlášení vypršelo, obnovte prosím autorizaci.');
    assert.ok(err instanceof Error, 'AuthUnavailableError extends Error');
    assert.ok(err instanceof AuthUnavailableError, 'err is an instance of AuthUnavailableError');
    assert.equal(err.code, 'AUTH_UNAVAILABLE');
    assert.equal(err.name, 'AuthUnavailableError');
    assert.ok(err.message.length > 0);
});

test('DriveJsonStore reports drive-client-unavailable when gapi drive client is missing', async () => {
    installDriveGlobals({ request: async () => ({ status: 200 }) }, {
        google_access_token: 'token-123',
    });

    setGoogleServiceState({
        accessToken: 'token-123',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const store = new DriveJsonStore();
    const status = await store.initWithStatus();

    assert.equal(status.code, 'drive-client-unavailable');
    assert.equal(await store.init(), false);
    assert.equal(store.lastStatus.code, 'drive-client-unavailable');
});

test('DriveJsonStore reports folder-missing without createFolder and folder-created with createFolder', async () => {
    const createdFolders: string[] = [];
    installDriveGlobals({
        drive: {
            files: {
                list: async () => ({ result: { files: [] } }),
            },
        },
        request: async (args: { body: string }) => {
            const payload = JSON.parse(args.body) as { name?: string };
            if (payload.name) createdFolders.push(payload.name);
            return { status: 200, result: { id: 'folder-created' } };
        },
    }, {
        google_access_token: 'token-123',
    });

    setGoogleServiceState({
        accessToken: 'token-123',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const missingStore = new DriveJsonStore();
    const missingStatus = await missingStore.initWithStatus();
    assert.equal(missingStatus.code, 'folder-missing');
    assert.equal(missingStore.initialized, false);

    const createdStore = new DriveJsonStore();
    const createdStatus = await createdStore.initWithStatus({ createFolder: true });
    assert.equal(createdStatus.code, 'folder-created');
    assert.equal(createdStore.initialized, true);
    assert.deepEqual(createdFolders, ['Anu-BattlePlan']);
});

test('DriveJsonStore readJsonFileWithStatus reads JSON and strong ETags from the authenticated GAPI response', async () => {
    const mediaResponses: Array<unknown> = [
        { status: 200, result: { source: 'result' }, headers: { eTaG: '"strong-etag:bytes"' } },
        { status: 200, body: '{"source":"body"}' },
        { status: 200, result: { source: 'empty-etag' }, headers: { ETag: '' } },
        { status: 200, result: { source: 'weak-etag' }, headers: { ETAG: 'W/"weak-etag"' } },
        { status: 503, statusText: 'Unavailable', result: { source: 'ignored' }, headers: { ETag: '"ignored"' } },
    ];
    const mediaRequests: Array<{ path: string; method: string; headers: Record<string, string>; body: string }> = [];
    let mediaResponseIndex = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
        throw new Error('Drive JSON reads must not use fetch');
    };

    installDriveGlobals({
        drive: {
            files: {
                list: async (args: { q: string }) => {
                    if (args.q.includes('missing.json')) return { result: { files: [] } };
                    return { result: { files: [{ id: 'file-existing', name: 'data.json' }] } };
                },
            },
        },
        request: async (args: { path: string; method: string; headers: Record<string, string>; body: string }) => {
            mediaRequests.push(args);
            const response = mediaResponses[mediaResponseIndex++];
            if (response instanceof Error) throw response;
            return response;
        },
    }, { bp_folder_id: 'folder-existing' });

    setGoogleServiceState({
        accessToken: 'fresh-live-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        userEmail: 'user@example.com',
    });

    const store = new DriveJsonStore();
    assert.equal(await store.init(), true);

    assert.deepEqual(await store.readJsonFileWithStatus('missing.json'), { kind: 'missing-file' });

    assert.deepEqual(await store.readJsonFileWithStatus<{ source: string }>('data.json'), {
        kind: 'loaded',
        fileId: 'file-existing',
        data: { source: 'result' },
        etag: '"strong-etag:bytes"',
    });
    assert.deepEqual(await store.readJsonFileWithStatus<{ source: string }>('data.json'), {
        kind: 'loaded',
        fileId: 'file-existing',
        data: { source: 'body' },
    });
    assert.deepEqual(await store.readJsonFileWithStatus<{ source: string }>('data.json'), {
        kind: 'loaded',
        fileId: 'file-existing',
        data: { source: 'empty-etag' },
    });
    assert.deepEqual(await store.readJsonFileWithStatus<{ source: string }>('data.json'), {
        kind: 'loaded',
        fileId: 'file-existing',
        data: { source: 'weak-etag' },
    });
    assert.deepEqual(await store.readJsonFileWithStatus('data.json'), {
        kind: 'error',
        message: 'Drive JSON media read failed: 503 Unavailable',
    });

    mediaResponses.push(new Error('GAPI transport rejected'));
    assert.deepEqual(await store.readJsonFileWithStatus('data.json'), {
        kind: 'error',
        message: 'GAPI transport rejected',
    });

    assert.deepEqual(mediaRequests.map(({ path, method, headers, body }) => ({ path, method, headers, body })), [
        ...Array.from({ length: 6 }, () => ({
            path: '/drive/v3/files/file-existing?alt=media&supportsAllDrives=true',
            method: 'GET',
            headers: {},
            body: '',
        })),
    ]);
});

test('buildMultipartRawJsonBody preserves the exact canonical protocol bytes', () => {
    const canonical = '{"10":"ten","2":"two"}';
    const body = buildMultipartRawJsonBody(
        buildDriveFileMetadata('message.json', 'application/json', 'folder-123', null),
        canonical,
        'boundary-test',
    );

    assert.match(body, /\r\n\r\n\{"10":"ten","2":"two"\}\r\n--boundary-test--$/);
    assert.doesNotMatch(body, /\{"2":"two","10":"ten"\}/);
});

test('GapiDriveProtocolApi issues exact-ID, paginated, all-drives-safe transport requests', async () => {
    const requests: Array<{ path: string; method: string; body: string }> = [];
    installDriveGlobals({
        request: async (args: { path: string; method: string; body: string }) => {
            requests.push(args);
            if (args.path.includes('/changes/startPageToken')) {
                return { status: 200, result: { startPageToken: 'start-1' } };
            }
            if (args.path.includes('/changes?')) {
                return {
                    status: 200,
                    result: {
                        changes: [{
                            fileId: 'message-1',
                            removed: false,
                            file: {
                                id: 'message-1',
                                name: 'message.json',
                                mimeType: 'application/json',
                                parents: ['folder-v2'],
                                properties: {},
                                size: '2',
                            },
                        }],
                        newStartPageToken: 'start-2',
                    },
                };
            }
            if (args.path.includes('/files?')) {
                return { status: 200, result: { files: [], nextPageToken: 'page-2', incompleteSearch: false } };
            }
            return {
                status: 200,
                result: {
                    id: 'folder-v2',
                    name: 'BattlePlan-Hermes-v2',
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: ['root'],
                    trashed: false,
                    owners: [{ permissionId: 'owner-1' }],
                },
            };
        },
    });
    const api = new GapiDriveProtocolApi({
        accountId: 'user@example.com',
        folderId: 'folder-v2',
        folderName: 'BattlePlan-Hermes-v2',
        expectedParentId: 'root',
        authority: { kind: 'owner', ownerPermissionId: 'owner-1' },
        workspaceId: 'workspace-1',
    });

    assert.equal((await api.getFile('folder-v2')).id, 'folder-v2');
    assert.equal((await api.listMessageFiles({ folderId: 'folder-v2', workspaceId: 'workspace-1', pageToken: 'page-1' })).nextPageToken, 'page-2');
    assert.equal(await api.getStartPageToken(), 'start-1');
    assert.equal((await api.listChanges('start-1')).newStartPageToken, 'start-2');

    assert.match(requests[0].path, /files\/folder-v2\?/);
    assert.match(requests[0].path, /supportsAllDrives=true/);
    assert.match(decodeURIComponent(requests[1].path), /'folder-v2' in parents/);
    assert.match(decodeURIComponent(requests[1].path), /bpv2_workspace_id/);
    assert.match(requests[1].path, /pageToken=page-1/);
    assert.match(requests[3].path, /includeItemsFromAllDrives=true/);
});

test('GapiDriveProtocolApi creates canonical bodies with a pre-generated immutable Drive ID', async () => {
    const requests: Array<{ path: string; method: string; body: string }> = [];
    installDriveGlobals({
        request: async (args: { path: string; method: string; body: string }) => {
            requests.push(args);
            if (args.path.includes('generateIds')) return { status: 200, result: { ids: ['reserved-1'] } };
            return { status: 200, result: { id: 'reserved-1' } };
        },
    });
    const api = new GapiDriveProtocolApi({
        accountId: 'user@example.com',
        folderId: 'folder-v2',
        folderName: 'BattlePlan-Hermes-v2',
        expectedParentId: 'root',
        authority: { kind: 'owner', ownerPermissionId: 'owner-1' },
        workspaceId: 'workspace-1',
    });

    assert.equal(await api.generateFileId(), 'reserved-1');
    await api.createImmutableFile({
        fileId: 'reserved-1',
        body: '{"hello":"world"}',
        metadata: {
            id: 'reserved-1',
            name: 'message.json',
            mimeType: 'application/json',
            parents: ['folder-v2'],
            trashed: false,
            owners: [],
            driveId: null,
            properties: { bpv2_message_id: 'message-1' },
            size: '17',
        },
    });

    assert.match(requests[0].path, /generateIds/);
    assert.match(requests[1].path, /uploadType=multipart/);
    assert.match(requests[1].body, /"id":"reserved-1"/);
    assert.match(requests[1].body, /"parents":\["folder-v2"\]/);
    assert.match(requests[1].body, /"hello":"world"/);
    assert.doesNotMatch(requests[1].body, /Bearer|access_token/i);
});
