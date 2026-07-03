/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDriveFileMetadata,
    buildMultipartJsonBody,
    DriveJsonStore,
    getUploadedDriveFileId,
} from './driveJsonStore.ts';

interface MockLocalStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    clear: () => void;
}

interface MockWindow {
    gapi?: unknown;
    localStorage: MockLocalStorage;
}

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
        localStorage,
    };
    const globals = globalThis as unknown as { window: MockWindow; localStorage: MockLocalStorage };
    globals.window = mockWindow;
    globals.localStorage = localStorage;
    return mockWindow;
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

    const store = new DriveJsonStore();
    assert.equal(await store.init(), true);

    await assert.rejects(
        () => store.writeJsonFile("data's.json", { hello: 'world' }),
        /Drive JSON upload failed: 500 Nope/,
    );
    assert.match(queries[0], /name='data\\'s\.json'/);
    assert.match(queries[0], /'folder\\'\\\\id' in parents/);
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

    const store = new DriveJsonStore();
    assert.equal(await store.init({ createFolder: true }), true);
    assert.equal(store.currentFolderId, 'folder-created');
    assert.deepEqual(createdFolders, ['Anu-BattlePlan']);
});
