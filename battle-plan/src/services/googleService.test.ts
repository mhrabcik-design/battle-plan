/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map<string, string>();
const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
        store.set(key, String(value));
    },
    removeItem: (key: string) => {
        store.delete(key);
    },
    clear: () => {
        store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
        return store.size;
    },
};
(globalThis as unknown as { window: { localStorage: typeof localStorage; dispatchEvent: (e: Event) => boolean; addEventListener: () => void; removeEventListener: () => void } }).window = {
    localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
};
(globalThis as unknown as { localStorage: typeof localStorage }).localStorage = localStorage;

const { GoogleService } = await import('./googleService.ts');

function freshService(): InstanceType<typeof GoogleService> {
    return new GoogleService();
}

function clearStore() {
    store.clear();
}

test('getAuthState returns SIGNED_IN when fresh token is in localStorage and within expiry window', () => {
    clearStore();
    localStorage.setItem('google_access_token', 'fresh-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    const status = svc.getAuthStatus();

    assert.equal(status.state, 'SIGNED_IN');
    assert.equal(status.accessToken, 'fresh-token');
});

test('getAuthState returns SIGNED_OUT when no token and no userEmail (never signed in)', () => {
    clearStore();
    const svc = freshService();
    const status = svc.getAuthStatus();

    assert.equal(status.state, 'SIGNED_OUT');
    assert.equal(status.accessToken, null);
});

test('getAuthState returns REFRESH_PENDING when token and userEmail present but expiresAt within 60s', () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-but-storable-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 30 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    const status = svc.getAuthStatus();

    assert.equal(status.state, 'REFRESH_PENDING');
    assert.equal(status.accessToken, 'stale-but-storable-token');
});

test('getAuthState returns REFRESH_PENDING when token already expired (idle app reopens) — not OFFLINE_AUTH', () => {
    clearStore();
    localStorage.setItem('google_access_token', 'expired-but-stored');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    const status = svc.getAuthStatus();

    assert.equal(status.state, 'REFRESH_PENDING');
    assert.equal(status.accessToken, 'expired-but-stored');
});

test('getAuthState returns SIGNED_OUT after user-initiated signOut clears all localStorage keys', () => {
    clearStore();
    localStorage.setItem('google_access_token', 'will-be-cleared');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    svc.signOut();

    assert.equal(localStorage.getItem('google_access_token'), null);
    assert.equal(localStorage.getItem('google_token_expires_at'), null);
    assert.equal(localStorage.getItem('google_user_email'), null);

    const status = svc.getAuthStatus();
    assert.equal(status.state, 'SIGNED_OUT');
    assert.equal(status.accessToken, null);
});

test('getAuthState returns SIGNED_OUT when token was never present and userEmail was cleared', () => {
    clearStore();
    const svc = freshService();
    const status = svc.getAuthStatus();

    assert.equal(status.state, 'SIGNED_OUT');
    assert.equal(status.accessToken, null);
});

test('getAuthState convenience method matches getAuthStatus().state', () => {
    clearStore();
    localStorage.setItem('google_access_token', 'fresh-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    const stateOnly = svc.getAuthState();
    const status = svc.getAuthStatus();

    assert.equal(stateOnly, status.state);
    assert.equal(stateOnly, 'SIGNED_IN');
});

type DispatchedEvent = { name: string; detail: unknown };
const capturedEvents: DispatchedEvent[] = [];
(globalThis as unknown as { window: { localStorage: typeof localStorage; dispatchEvent: (e: Event) => boolean; addEventListener: () => void; removeEventListener: () => void; gapi?: unknown; google?: unknown } }).window = (globalThis as unknown as { window: { localStorage: typeof localStorage; dispatchEvent: (e: Event) => boolean; addEventListener: () => void; removeEventListener: () => void; gapi?: unknown; google?: unknown } }).window;
(globalThis as unknown as { window: { localStorage: typeof localStorage; dispatchEvent: (e: Event) => boolean; addEventListener: () => void; removeEventListener: () => void; gapi?: unknown; google?: unknown } }).window.dispatchEvent = (e: Event) => {
    capturedEvents.push({ name: (e as CustomEvent).type, detail: (e as CustomEvent).detail });
    return true;
};

function resetEventCapture() {
    capturedEvents.length = 0;
}

function installGapiMock(api: {
    tasklistsList?: () => Promise<unknown>;
    tasksList?: () => Promise<unknown>;
    tasksInsert?: () => Promise<unknown>;
    tasksPatch?: () => Promise<unknown>;
    tasksDelete?: () => Promise<unknown>;
    calendarEventsInsert?: () => Promise<unknown>;
    calendarEventsUpdate?: () => Promise<unknown>;
    calendarEventsDelete?: () => Promise<unknown>;
}) {
    (globalThis as unknown as { window: { gapi: unknown } }).window.gapi = {
        client: {
            setToken: () => {},
            tasks: {
                tasklists: { list: api.tasklistsList ?? (async () => ({ result: { items: [] } })) },
                tasks: {
                    list: api.tasksList ?? (async () => ({ result: { items: [] } })),
                    insert: api.tasksInsert ?? (async () => ({ result: {} })),
                    patch: api.tasksPatch ?? (async () => ({ result: {} })),
                    delete: api.tasksDelete ?? (async () => {}),
                },
            },
            calendar: {
                events: {
                    insert: api.calendarEventsInsert ?? (async () => ({ result: { id: 'evt-1' } })),
                    update: api.calendarEventsUpdate ?? (async () => ({ result: { id: 'evt-1' } })),
                    delete: api.calendarEventsDelete ?? (async () => {}),
                },
            },
        },
    };
}

function installGisMock(opts?: { initTokenClient?: (config: unknown) => unknown }) {
    (globalThis as unknown as { window: { google: unknown } }).window.google = {
        accounts: {
            oauth2: {
                initTokenClient: opts?.initTokenClient ?? ((config: unknown) => {
                    void config;
                    return { requestAccessToken: () => {} };
                }),
            },
        },
    };
}

function removeItemSpy() {
    const calls: string[] = [];
    const original = localStorage.removeItem;
    localStorage.removeItem = (key: string) => {
        calls.push(key);
        original(key);
    };
    return {
        calls,
        restore: () => {
            localStorage.removeItem = original;
        },
    };
}

test('lazy refresh: fresh token — getTaskLists proceeds without invoking trySilentRefresh', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'fresh-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    let refreshCalls = 0;
    let tasklistsListCalls = 0;
    installGapiMock({
        tasklistsList: async () => {
            tasklistsListCalls++;
            return { result: { items: [{ id: 'list-1', title: 'My List' }] } };
        },
    });

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => {
        refreshCalls++;
        return true;
    };

    const result = await svc.getTaskLists();
    assert.deepEqual(result, [{ id: 'list-1', title: 'My List' }]);
    assert.equal(tasklistsListCalls, 1);
    assert.equal(refreshCalls, 0);
});

test('lazy refresh: expired token, silent refresh succeeds — getTaskLists proceeds', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    let refreshCalls = 0;
    let tasklistsListCalls = 0;
    installGapiMock({
        tasklistsList: async () => {
            tasklistsListCalls++;
            return { result: { items: [{ id: 'list-1' }] } };
        },
    });

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async function (this: InstanceType<typeof GoogleService>) {
        refreshCalls++;
        (this as unknown as { expiresAt: number }).expiresAt = Date.now() + 60 * 60 * 1000;
        return true;
    };

    const result = await svc.getTaskLists();
    assert.deepEqual(result, [{ id: 'list-1' }]);
    assert.equal(tasklistsListCalls, 1);
    assert.equal(refreshCalls, 1);
});

test('lazy refresh: expired token, silent refresh fails — getTaskLists returns [] and does not call signOut or clear localStorage', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({
        tasklistsList: async () => ({ result: { items: [{ id: 'should-not-reach' }] } }),
    });

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => false;

    let signOutCalls = 0;
    (svc as unknown as { signOut: () => void }).signOut = () => {
        signOutCalls++;
    };

    const lsSpy = removeItemSpy();

    const result = await svc.getTaskLists();
    assert.deepEqual(result, []);
    assert.equal(signOutCalls, 0);
    assert.equal(lsSpy.calls.length, 0);
    assert.equal(localStorage.getItem('google_access_token'), 'stale-token');
    assert.equal(localStorage.getItem('google_user_email'), 'user@example.com');

    lsSpy.restore();
});

test('lazy refresh: expired token, silent refresh fails — getTasks returns [] and createGoogleTask returns null', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({});

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => false;

    let signOutCalls = 0;
    (svc as unknown as { signOut: () => void }).signOut = () => {
        signOutCalls++;
    };

    const lsSpy = removeItemSpy();

    const tasksResult = await svc.getTasks();
    const createResult = await svc.createGoogleTask('title');
    const updateResult = await svc.updateGoogleTask('task-1', { title: 'x' });
    const deleteResult = await svc.deleteGoogleTask('task-1');
    const addResult = await svc.addToCalendar({ title: 't', date: '2026-07-04' });
    const deleteCalResult = await svc.deleteFromCalendar('evt-1');

    assert.deepEqual(tasksResult, []);
    assert.equal(createResult, null);
    assert.equal(updateResult, null);
    assert.equal(deleteResult, undefined);
    assert.equal(addResult, undefined);
    assert.equal(deleteCalResult, undefined);
    assert.equal(signOutCalls, 0);
    assert.equal(lsSpy.calls.length, 0);

    lsSpy.restore();
});

test('lazy refresh: 401 from Calendar API after successful silent refresh — addToCalendar returns sentinel, no signOut, no clear', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'fresh-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({
        calendarEventsInsert: async () => {
            const err: unknown = new Error('Unauthorized');
            (err as { status?: number }).status = 401;
            throw err;
        },
    });

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => true;

    let signOutCalls = 0;
    (svc as unknown as { signOut: () => void }).signOut = () => {
        signOutCalls++;
    };

    const lsSpy = removeItemSpy();

    let result: unknown = 'sentinel-not-set';
    let threw = false;
    try {
        result = await svc.addToCalendar({ title: 't', date: '2026-07-04' });
    } catch {
        threw = true;
    }

    assert.equal(threw, false, 'addToCalendar must not throw on 401 (it should silently return)');
    assert.equal(result, undefined);
    assert.equal(signOutCalls, 0);
    assert.equal(lsSpy.calls.length, 0);
    assert.equal(localStorage.getItem('google_access_token'), 'fresh-token');

    lsSpy.restore();
});

test('lazy refresh: 401 from Calendar API — deleteFromCalendar returns sentinel, no signOut, no clear', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'fresh-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({
        calendarEventsDelete: async () => {
            const err: unknown = new Error('Unauthorized');
            (err as { status?: number }).status = 401;
            throw err;
        },
    });

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => true;

    let signOutCalls = 0;
    (svc as unknown as { signOut: () => void }).signOut = () => {
        signOutCalls++;
    };

    const lsSpy = removeItemSpy();

    let threw = false;
    let result: unknown = 'sentinel-not-set';
    try {
        result = await svc.deleteFromCalendar('evt-1');
    } catch {
        threw = true;
    }

    assert.equal(threw, false, 'deleteFromCalendar must not throw on 401');
    assert.equal(result, undefined);
    assert.equal(signOutCalls, 0);
    assert.equal(lsSpy.calls.length, 0);

    lsSpy.restore();
});

test('lazy refresh integration: 401 from calendar — google-auth-change event never carries isSignedIn:false', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'fresh-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    resetEventCapture();

    installGapiMock({
        calendarEventsInsert: async () => {
            const err: unknown = new Error('Unauthorized');
            (err as { status?: number }).status = 401;
            throw err;
        },
    });

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => true;

    await svc.addToCalendar({ title: 't', date: '2026-07-04' });

    for (const evt of capturedEvents) {
        if (evt.name === 'google-auth-change') {
            const detail = evt.detail as { isSignedIn?: boolean; state?: string };
            assert.equal(detail.isSignedIn, undefined, 'event detail must not include isSignedIn');
            assert.ok(typeof detail.state === 'string', 'event detail must include state');
        }
    }
});

test('race fix: trySilentRefresh with no GIS callback and stale accessToken resolves false (not true)', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'will-go-stale');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGisMock({
        initTokenClient: () => ({
            requestAccessToken: () => {
                // intentionally do not invoke the callback — simulates GIS never firing
            },
        }),
    });

    const svc = freshService();
    (svc as unknown as { tokenClient: unknown }).tokenClient = {};

    const result = await svc.trySilentRefresh();
    assert.equal(result, false, 'trySilentRefresh must resolve to false when the GIS callback never fires, even if accessToken is set');
});