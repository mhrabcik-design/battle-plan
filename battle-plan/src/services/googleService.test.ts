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

    const statusAfter401 = svc.getAuthStatus();
    assert.equal(statusAfter401.state, 'OFFLINE_AUTH', 'after 401 the auth state must be OFFLINE_AUTH so the UI can show the offline-auth banner');
    assert.equal(statusAfter401.accessToken, null, 'after 401 the in-memory accessToken must be null');

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
    assert.equal(localStorage.getItem('google_access_token'), 'fresh-token');

    const statusAfter401 = svc.getAuthStatus();
    assert.equal(statusAfter401.state, 'OFFLINE_AUTH', 'after 401 the auth state must be OFFLINE_AUTH so the UI can show the offline-auth banner');
    assert.equal(statusAfter401.accessToken, null, 'after 401 the in-memory accessToken must be null');

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

    let offLineAuthEventSeen = false;
    for (const evt of capturedEvents) {
        if (evt.name === 'google-auth-change') {
            const detail = evt.detail as { isSignedIn?: boolean; state?: string; accessToken?: string | null };
            assert.equal(detail.isSignedIn, undefined, 'event detail must not include isSignedIn');
            assert.ok(typeof detail.state === 'string', 'event detail must include state');
            if (detail.state === 'OFFLINE_AUTH') {
                offLineAuthEventSeen = true;
                assert.equal(detail.accessToken, null, 'OFFLINE_AUTH event detail must carry accessToken:null');
            }
        }
    }
    assert.equal(offLineAuthEventSeen, true, 'google-auth-change event with state OFFLINE_AUTH must be dispatched after a 401');
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

test('runRefresh: concurrent ensureFreshToken invocations only call initTokenClient once (in-flight dedup)', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    (svc as unknown as { tokenClient: unknown }).tokenClient = {};

    let trySilentRefreshCalls = 0;
    let release: () => void = () => {};
    const refreshPromise = new Promise<boolean>((resolve) => {
        release = () => resolve(true);
    });
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => {
        trySilentRefreshCalls++;
        return refreshPromise;
    };

    const taskListsPromise = svc.getTaskLists();
    const tasksPromise = svc.getTasks('@default');

    await Promise.resolve();

    assert.equal(trySilentRefreshCalls, 1, 'concurrent ensureFreshToken calls must share a single in-flight refresh, not each invoke trySilentRefresh');

    release();
    const [taskLists, tasks] = await Promise.all([taskListsPromise, tasksPromise]);
    assert.ok(Array.isArray(taskLists), 'getTaskLists should still return [] (empty array sentinel) without throwing');
    assert.ok(Array.isArray(tasks), 'getTasks should still return [] without throwing');
});

test('U3: first sign-in — no prior userEmail — signIn() creates a new initTokenClient with prompt:consent + include_granted_scopes and calls requestAccessToken on it', () => {
    clearStore();
    // explicitly: no google_user_email in localStorage => first sign-in
    localStorage.setItem('google_access_token', 'stale-previous');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    // no google_user_email set

    let initCallCount = 0;
    let capturedConfig: unknown = null;
    let newClientRequestCount = 0;
    const newClientRequestOptions: unknown[] = [];

    installGisMock({
        initTokenClient: (config: unknown) => {
            initCallCount++;
            capturedConfig = config;
            return {
                requestAccessToken: (options: unknown) => {
                    newClientRequestCount++;
                    newClientRequestOptions.push(options);
                },
            };
        },
    });

    const svc = freshService();
    // Provide a pre-existing singleton tokenClient; signIn() must NOT use it because this is a first sign-in
    const singletonRequestCount = 0;
    const singletonRequestOptions: unknown[] = [];
    (svc as unknown as { tokenClient: unknown }).tokenClient = {
        requestAccessToken: (options: unknown) => {
            // singleton client - signIn() must not call this
            singletonRequestOptions.push(options);
        },
    };
    void singletonRequestCount;

    svc.signIn();

    assert.equal(initCallCount, 1, 'signIn() must create exactly one new TokenClient on first sign-in');
    const cfg = capturedConfig as { prompt?: string; include_granted_scopes?: boolean; scope?: string; client_id?: string; callback?: unknown };
    assert.ok(cfg && typeof cfg === 'object', 'initTokenClient must receive a config object');
    assert.equal(cfg.prompt, 'consent', 'first-sign-in TokenClient config must include prompt=consent');
    assert.equal(cfg.include_granted_scopes, false, 'first-sign-in TokenClient config must request exactly the current scope set');
    assert.ok(typeof cfg.callback === 'function', 'first-sign-in TokenClient config must include a callback');
    assert.ok(typeof cfg.scope === 'string' && cfg.scope.length > 0, 'first-sign-in TokenClient config must include scope');
    assert.ok(typeof cfg.client_id === 'string', 'first-sign-in TokenClient config must include client_id');

    assert.equal(newClientRequestCount, 1, 'requestAccessToken must be invoked exactly once on the new client');
    const reqOpts = newClientRequestOptions[0] as { prompt?: string; scope?: string; include_granted_scopes?: boolean; login_hint?: string | null } | undefined;
    assert.ok(reqOpts && typeof reqOpts === 'object', 'requestAccessToken must receive an options object');
    assert.equal(reqOpts.prompt, 'consent', 'first-sign-in must force prompt=consent on the request override');
    assert.equal(reqOpts.scope, cfg.scope, 'first-sign-in request override must repeat the full scope string');
    assert.equal(reqOpts.include_granted_scopes, false, 'first-sign-in request override must request exactly the current scope set');

    // Singleton client must NOT be used on first sign-in
    assert.deepEqual(singletonRequestOptions, [], 'singleton tokenClient must NOT be invoked on first sign-in');
});

test('signIn always uses a fresh consentClient (regardless of stored userEmail) so the user can re-grant a new scope set', () => {
    clearStore();
    // A userEmail is already in localStorage from a prior session. Even so,
    // signIn must create a fresh consentClient with prompt=consent and
    // include_granted_scopes=false so GIS issues a token for exactly the
    // current scope set. Passing prompt="" at request time suppresses
    // returning-user consent and was the production cause of old-scope
    // tokens followed by Tasks API 403.
    localStorage.setItem('google_access_token', 'existing-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    let initCallCount = 0;
    let consentRequestCount = 0;
    const consentRequestOptions: { prompt?: string }[] = [];
    let capturedConsentConfig: unknown = null;

    installGisMock({
        initTokenClient: (config: unknown) => {
            initCallCount++;
            // Capture the first initTokenClient call (the consentClient
            // for the user-visible sign-in flow).
            if (initCallCount === 1) {
                capturedConsentConfig = config;
            }
            return {
                requestAccessToken: (options: unknown) => {
                    consentRequestCount++;
                    // options is the user-supplied requestAccessToken options
                    // object. We only read .prompt from it later in the
                    // assertion; cast through unknown so the array push is
                    // safe even if GIS ever passes a non-object.
                    const opts = (options && typeof options === 'object' ? options : {}) as { prompt?: string };
                    consentRequestOptions.push(opts);
                },
            };
        },
    });

    const svc = freshService();
    svc.signIn();

    assert.ok(initCallCount >= 1, 'signIn() must call initTokenClient at least once to create a fresh consentClient');
    assert.equal(consentRequestCount, 1, 'signIn() must call requestAccessToken on the fresh consentClient exactly once');
    assert.ok(capturedConsentConfig && typeof capturedConsentConfig === 'object', 'consentClient initTokenClient must receive a config object');
    const cfg = capturedConsentConfig as { prompt?: string; include_granted_scopes?: boolean; scope?: string };
    assert.equal(cfg.prompt, 'consent', 'consentClient must request prompt=consent so the user is re-prompted for new scopes');
    assert.equal(cfg.include_granted_scopes, false, 'consentClient must request exactly the current scope set');
    assert.ok(typeof cfg.scope === 'string' && cfg.scope.length > 0, 'consentClient must include the full SCOPES string');
    const reqOpts = consentRequestOptions[0] as { prompt?: string; scope?: string; include_granted_scopes?: boolean } | undefined;
    assert.ok(reqOpts && typeof reqOpts === 'object', 'consentClient requestAccessToken must receive an options object');
    assert.equal(reqOpts.prompt, 'consent', 'consentClient requestAccessToken must force prompt=consent; prompt="" suppresses returning-user consent and returns stale scopes');
    assert.equal(reqOpts.scope, cfg.scope, 'consentClient requestAccessToken must repeat the full scope string so the override cannot narrow scopes');
    assert.equal(reqOpts.include_granted_scopes, false, 'consentClient requestAccessToken must request exactly the current scope set');
});

test('signIn scope set includes userinfo and all Google API scopes needed by the app', () => {
    clearStore();
    let capturedConfig: unknown = null;

    installGisMock({
        initTokenClient: (config: unknown) => {
            capturedConfig = config;
            return { requestAccessToken: () => {} };
        },
    });

    const svc = freshService();
    svc.signIn();

    const cfg = capturedConfig as { scope?: string } | undefined;
    assert.ok(cfg?.scope, 'signIn must send a scope string');
    const scopes = cfg.scope.split(/\s+/);
    assert.ok(scopes.includes('openid'), 'scope must include openid so oauth2/v3/userinfo accepts the access token');
    assert.ok(scopes.includes('email'), 'scope must include email so oauth2/v3/userinfo can return the signed-in email');
    assert.ok(scopes.includes('profile'), 'scope must include profile for the userinfo endpoint');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.events'), 'scope must include calendar.events');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/drive'), 'scope must include full Drive access');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/tasks'), 'scope must include Google Tasks access');
});

test('handleTokenResponse accepts core scopes and disables Google Tasks when the token omits Tasks scope', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'old-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    let tasklistsListCalls = 0;
    installGapiMock({
        tasklistsList: async () => {
            tasklistsListCalls++;
            return { result: { items: [{ id: 'list-1' }] } };
        },
    });
    installGisMock({});

    const svc = freshService();
    const handler = (svc as unknown as { handleTokenResponse: (r: { access_token: string; expires_in: number; scope: string }) => void }).handleTokenResponse;
    handler({
        access_token: 'token-without-tasks-scope',
        expires_in: 3600,
        scope: 'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive',
    });

    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN', 'token with core scopes must keep Drive auth active');
    assert.equal(svc.getAuthStatus().accessToken, 'token-without-tasks-scope', 'core-scoped token becomes the active Drive token');
    assert.equal(localStorage.getItem('google_access_token'), 'token-without-tasks-scope', 'core-scoped token must persist');
    assert.deepEqual(await svc.getTaskLists(), [], 'missing optional Tasks scope must skip Google Tasks calls');
    assert.equal(tasklistsListCalls, 0, 'Google Tasks API must not be called when the token lacks Tasks scope');
});

test('handleTokenResponse trusts response.scope over GIS helper for optional Tasks scope', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'old-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    let tasksListCalls = 0;
    installGapiMock({
        tasksList: async () => {
            tasksListCalls++;
            return { result: { items: [{ id: 'task-1' }] } };
        },
    });
    installGisMock({});
    (globalThis as unknown as {
        window: {
            google: {
                accounts: {
                    oauth2: {
                        hasGrantedAllScopes: () => boolean;
                    };
                };
            };
        };
    }).window.google.accounts.oauth2.hasGrantedAllScopes = () => true;

    const svc = freshService();
    const handler = (svc as unknown as { handleTokenResponse: (r: { access_token: string; expires_in: number; scope: string }) => void }).handleTokenResponse;
    handler({
        access_token: 'token-without-tasks-scope',
        expires_in: 3600,
        scope: 'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive',
    });

    assert.deepEqual(await svc.getTasks('@default'), [], 'explicit response.scope without Tasks must suppress Google Tasks API calls');
    assert.equal(tasksListCalls, 0, 'stale GIS granted-scope helper must not trigger a Tasks network request');
});

test('U3: integration — successful first-sign-in token response populates google_access_token, google_token_expires_at, and google_user_email in localStorage', async () => {
    clearStore();
    // No userEmail => first sign-in
    // Pre-existing stale access token to confirm it gets overwritten.
    localStorage.setItem('google_access_token', 'stale-previous');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    // no google_user_email set

    let firstSignInConfig: unknown = null;
    installGapiMock({});
    installGisMock({
        initTokenClient: (config: unknown) => {
            firstSignInConfig = config;
            return {
                requestAccessToken: (options: unknown) => {
                    // Simulate the GIS library invoking the callback the moment requestAccessToken is called.
                    void options;
                    const cfg = firstSignInConfig as { callback?: (response: { access_token: string; expires_in: number }) => void };
                    cfg.callback?.({
                        access_token: 'first-signin-fresh-token',
                        expires_in: 3600,
                    });
                },
            };
        },
    });

    const svc = freshService();
    // Stub out fetchUserInfo (called from the token callback when userEmail is absent)
    (svc as unknown as { fetchUserInfo: () => Promise<void> }).fetchUserInfo = async function (this: InstanceType<typeof GoogleService>) {
        (this as unknown as { userEmail: string }).userEmail = 'first-signin-user@example.com';
        localStorage.setItem('google_user_email', 'first-signin-user@example.com');
    };

    // Assert the config is wired up for the first-sign-in flow
    svc.signIn();
    const cfg = firstSignInConfig as { prompt?: string; include_granted_scopes?: boolean } | undefined;
    assert.ok(cfg && typeof cfg === 'object', 'first sign-in must invoke initTokenClient with a config');
    assert.equal(cfg.prompt, 'consent', 'first sign-in config must set prompt=consent');
    assert.equal(cfg.include_granted_scopes, false, 'first sign-in config must request exactly the current scope set');

    // Yield so the callback's setTimeout-less promise chain settles (none in this flow; just for symmetry)
    await Promise.resolve();

    assert.equal(localStorage.getItem('google_access_token'), 'first-signin-fresh-token', 'callback must persist new access_token');
    assert.ok(typeof localStorage.getItem('google_token_expires_at') === 'string' && localStorage.getItem('google_token_expires_at') !== null, 'callback must persist google_token_expires_at');
    assert.equal(Number(localStorage.getItem('google_token_expires_at')) > Date.now(), true, 'expires_at must be in the future');
    assert.equal(localStorage.getItem('google_user_email'), 'first-signin-user@example.com', 'user_email must be persisted on first sign-in');
});

test('OFFLINE_AUTH: never signed in (no accessToken, no userEmail) → state is SIGNED_OUT, not OFFLINE_AUTH', () => {
    clearStore();
    // Pre-condition: empty localStorage
    assert.equal(localStorage.getItem('google_user_email'), null);
    assert.equal(localStorage.getItem('google_access_token'), null);

    const svc = freshService();
    const status = svc.getAuthStatus();

    assert.equal(status.state, 'SIGNED_OUT');
    assert.notEqual(status.state, 'OFFLINE_AUTH');
    assert.equal(status.accessToken, null);
});

test('OFFLINE_AUTH: previously signed in, silent refresh just failed, no fresh token → state is OFFLINE_AUTH', () => {
    clearStore();
    // Pre-condition: user was signed in before (userEmail in localStorage), refresh failed so
    // lastRefreshFailedAt is set, and accessToken is now cleared (refresh path nulls it on failure).
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    // After construction the in-memory accessToken reflects what was in localStorage at boot.
    // Simulate the post-failed-refresh state: clear in-memory token and mark refresh failed.
    (svc as unknown as { accessToken: string | null }).accessToken = null;
    (svc as unknown as { lastRefreshFailedAt: number }).lastRefreshFailedAt = Date.now();

    const status = svc.getAuthStatus();

    assert.equal(status.state, 'OFFLINE_AUTH');
    assert.equal(status.accessToken, null);
});

test('OFFLINE_AUTH: silent refresh just succeeded → state is SIGNED_IN (or REFRESH_PENDING if within 60s of expiry) and lastRefreshFailedAt is null', () => {
    clearStore();
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    // Set up as if refresh just succeeded: fresh token in the future, lastRefreshFailedAt null.
    (svc as unknown as { accessToken: string | null }).accessToken = 'fresh-token';
    (svc as unknown as { expiresAt: number }).expiresAt = Date.now() + 60 * 60 * 1000;
    (svc as unknown as { lastRefreshFailedAt: number | null }).lastRefreshFailedAt = null;

    const status = svc.getAuthStatus();

    assert.equal(status.state, 'SIGNED_IN');
    assert.equal((svc as unknown as { lastRefreshFailedAt: number | null }).lastRefreshFailedAt, null);
});

test('OFFLINE_AUTH: silent refresh succeeded but token is within 60s of expiry → state is REFRESH_PENDING, lastRefreshFailedAt remains null', () => {
    clearStore();
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    (svc as unknown as { accessToken: string | null }).accessToken = 'fresh-but-soon-expiring';
    (svc as unknown as { expiresAt: number }).expiresAt = Date.now() + 30 * 1000; // 30s from now, inside the 60s window
    (svc as unknown as { lastRefreshFailedAt: number | null }).lastRefreshFailedAt = null;

    const status = svc.getAuthStatus();

    assert.equal(status.state, 'REFRESH_PENDING');
    assert.equal((svc as unknown as { lastRefreshFailedAt: number | null }).lastRefreshFailedAt, null);
});

test('OFFLINE_AUTH: signOut clears lastRefreshFailedAt and resets state to SIGNED_OUT — subsequent successful sign-in back to SIGNED_IN', () => {
    clearStore();
    localStorage.setItem('google_user_email', 'user@example.com');

    const svc = freshService();
    // Pretend the user is in OFFLINE_AUTH: stale refresh failure, no access token.
    (svc as unknown as { accessToken: string | null }).accessToken = null;
    (svc as unknown as { lastRefreshFailedAt: number }).lastRefreshFailedAt = Date.now();

    // Pre-signOut state: OFFLINE_AUTH
    assert.equal(svc.getAuthStatus().state, 'OFFLINE_AUTH');

    svc.signOut();

    // After explicit signOut: userEmail cleared, lastRefreshFailedAt reset.
    assert.equal(svc.getAuthStatus().state, 'SIGNED_OUT');
    assert.equal((svc as unknown as { lastRefreshFailedAt: number | null }).lastRefreshFailedAt, null);

    // Now simulate a successful re-sign-in (post-signOut state, fresh token arrives via handleTokenResponse).
    (svc as unknown as { accessToken: string | null }).accessToken = 'reauth-fresh-token';
    (svc as unknown as { expiresAt: number }).expiresAt = Date.now() + 60 * 60 * 1000;

    const status = svc.getAuthStatus();
    assert.equal(status.state, 'SIGNED_IN');
    assert.equal(status.accessToken, 'reauth-fresh-token');
});

test('OFFLINE_AUTH: successful signIn() after a failed refresh clears lastRefreshFailedAt and flips to SIGNED_IN', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'old-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({});

    // signIn() now always creates a fresh consentClient via initTokenClient
    // (the always-consent fix). We wire that consentClient's
    // requestAccessToken to invoke the same wire (handleTokenResponse)
    // that the real GIS library would, with a fresh post-reauth token.
    let capturedHandler: ((r: { access_token: string; expires_in: number }) => void) | null = null;
    installGisMock({
        initTokenClient: (config: unknown) => {
            const cfg = config as { callback?: (r: { access_token: string; expires_in: number }) => void } | undefined;
            capturedHandler = cfg?.callback ?? null;
            return {
                requestAccessToken: () => {
                    if (capturedHandler) {
                        capturedHandler({ access_token: 'post-reauth-fresh-token', expires_in: 3600 });
                    }
                },
            };
        },
    });

    const svc = freshService();

    // Pretend we were in OFFLINE_AUTH with a failed-refresh marker.
    (svc as unknown as { accessToken: string | null }).accessToken = null;
    (svc as unknown as { lastRefreshFailedAt: number }).lastRefreshFailedAt = Date.now();
    assert.equal(svc.getAuthStatus().state, 'OFFLINE_AUTH');

    svc.signIn();
    // Allow microtasks to settle (signIn is synchronous; the consentClient
    // mock invokes handleTokenResponse synchronously inside requestAccessToken,
    // which writes localStorage and dispatches the change event).
    await Promise.resolve();

    assert.equal((svc as unknown as { lastRefreshFailedAt: number | null }).lastRefreshFailedAt, null);
    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN');
    assert.equal(svc.getAuthStatus().accessToken, 'post-reauth-fresh-token');
});

// ---- U7: tests for the U1+U2+U4+U5 fixes from the auth-state-residual plan ----

test('U1: getAuthState transitions to OFFLINE_AUTH after a failed trySilentRefresh via ensureFreshToken', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');
    installGapiMock({});

    const svc = freshService();
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => false;

    // Pre-condition: state is REFRESH_PENDING
    assert.equal(svc.getAuthStatus().state, 'REFRESH_PENDING');

    const result = await svc.getTaskLists();
    assert.deepEqual(result, []);

    // U1 fix: a failed silent refresh now transitions the state machine
    // to OFFLINE_AUTH, not REFRESH_PENDING, so the user can re-grant from Settings.
    assert.equal(svc.getAuthStatus().state, 'OFFLINE_AUTH', 'ensureFreshToken failure must transition state to OFFLINE_AUTH');
    assert.equal(svc.getAuthStatus().accessToken, null);
});

test('U2.1: trySilentRefresh initTokenClient throw resolves false (no unhandled rejection)', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({});
    installGisMock({
        initTokenClient: () => {
            throw new Error('GIS blocked by ad blocker');
        },
    });

    // Use a 60ms timeout via the constructor option so the test is fast.
    const fastSvc = new GoogleService({ refreshTimeoutMs: 60 });
    (fastSvc as unknown as { accessToken: string | null }).accessToken = 'stale-token';
    (fastSvc as unknown as { expiresAt: number }).expiresAt = Date.now() - 5 * 60 * 1000;
    (fastSvc as unknown as { userEmail: string | null }).userEmail = 'user@example.com';
    (fastSvc as unknown as { tokenClient: unknown }).tokenClient = { requestAccessToken: () => {} };

    const result = await fastSvc.trySilentRefresh();
    assert.equal(result, false, 'initTokenClient throw must produce false, not a rejection');
    assert.equal((fastSvc as unknown as { lastRefreshFailedAt: number | null }).lastRefreshFailedAt !== null, true);
});

test('U2.2: trySilentRefresh gapi.client.setToken throw resolves false and state becomes OFFLINE_AUTH', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({});
    let callbackRef: ((response: { access_token?: string; expires_in?: number; error?: string }) => void) | null = null;
    installGisMock({
        initTokenClient: (config: unknown) => {
            const cfg = config as { callback: (response: { access_token?: string; expires_in?: number; error?: string }) => void };
            callbackRef = cfg.callback;
            return { requestAccessToken: () => { void callbackRef?.({ access_token: 'new-token', expires_in: 3600 }); } };
        },
    });
    // Override gapi.client.setToken to throw AFTER a successful response.
    (globalThis as unknown as { window: { gapi: { client: { setToken: (token: unknown) => void } } } }).window.gapi.client.setToken = () => {
        throw new Error('gapi setToken failed');
    };

    const svc = new GoogleService({ refreshTimeoutMs: 60 });
    (svc as unknown as { accessToken: string | null }).accessToken = 'stale-token';
    (svc as unknown as { expiresAt: number }).expiresAt = Date.now() - 5 * 60 * 1000;
    (svc as unknown as { userEmail: string | null }).userEmail = 'user@example.com';
    (svc as unknown as { tokenClient: unknown }).tokenClient = { requestAccessToken: () => {} };

    const result = await svc.trySilentRefresh();
    assert.equal(result, false, 'gapi setToken throw must produce false');
    assert.equal(svc.getAuthStatus().state, 'OFFLINE_AUTH', 'setToken throw must flip state to OFFLINE_AUTH');
    assert.equal(svc.getAuthStatus().accessToken, null);
});

test('U2.3: trySilentRefresh with empty access_token resolves false (no localStorage write)', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({});
    let callbackRef: ((response: { access_token?: string; expires_in?: number; error?: string }) => void) | null = null;
    installGisMock({
        initTokenClient: (config: unknown) => {
            const cfg = config as { callback: (response: { access_token?: string; expires_in?: number; error?: string }) => void };
            callbackRef = cfg.callback;
            return { requestAccessToken: () => { void callbackRef?.({ access_token: '', expires_in: 3600 }); } };
        },
    });

    const svc = new GoogleService({ refreshTimeoutMs: 60 });
    (svc as unknown as { accessToken: string | null }).accessToken = 'stale-token';
    (svc as unknown as { expiresAt: number }).expiresAt = Date.now() - 5 * 60 * 1000;
    (svc as unknown as { userEmail: string | null }).userEmail = 'user@example.com';
    (svc as unknown as { tokenClient: unknown }).tokenClient = { requestAccessToken: () => {} };

    const result = await svc.trySilentRefresh();
    assert.equal(result, false, 'empty access_token must produce false');
    // The empty access_token must NOT have been persisted.
    assert.notEqual(localStorage.getItem('google_access_token'), '', 'empty access_token must not be persisted');
    assert.equal(localStorage.getItem('google_access_token'), 'stale-token', 'prior token must remain intact');
});

test('U2.4: handleTokenResponse (consent path) gapi.client.setToken throw does not corrupt state', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'will-be-overwritten');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({});
    installGisMock({});
    (globalThis as unknown as { window: { gapi: { client: { setToken: (token: unknown) => void } } } }).window.gapi.client.setToken = () => {
        throw new Error('consent setToken failed');
    };

    const svc = freshService();
    // Drive the consent callback directly with a fresh token.
    const handler = (svc as unknown as { handleTokenResponse: (r: { access_token: string; expires_in: number }) => void }).handleTokenResponse;
    handler({ access_token: 'fresh-from-consent', expires_in: 3600 });

    // State must be OFFLINE_AUTH (setToken failure flipped it), not SIGNED_IN.
    assert.equal(svc.getAuthStatus().state, 'OFFLINE_AUTH', 'setToken throw on consent must flip state to OFFLINE_AUTH');
    assert.equal(svc.getAuthStatus().accessToken, null);
});

test('U4: GoogleService constructor option refreshTimeoutMs is honored', () => {
    clearStore();
    const svc50 = new GoogleService({ refreshTimeoutMs: 50 });
    const svcDefault = new GoogleService();
    assert.equal((svc50 as unknown as { refreshTimeoutMs: number }).refreshTimeoutMs, 50, 'explicit refreshTimeoutMs must be stored');
    assert.equal((svcDefault as unknown as { refreshTimeoutMs: number }).refreshTimeoutMs, 8000, 'default refreshTimeoutMs must be 8000');
});

test('U4: trySilentRefresh uses the configured refreshTimeoutMs when GIS does not invoke the callback', async () => {
    clearStore();
    localStorage.setItem('google_access_token', 'stale-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() - 5 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');

    installGapiMock({});
    installGisMock({
        // initTokenClient that never invokes the callback, simulating a hung GIS prompt.
        initTokenClient: () => ({ requestAccessToken: () => {} }),
    });

    const svc = new GoogleService({ refreshTimeoutMs: 80 });
    (svc as unknown as { accessToken: string | null }).accessToken = 'stale-token';
    (svc as unknown as { expiresAt: number }).expiresAt = Date.now() - 5 * 60 * 1000;
    (svc as unknown as { userEmail: string | null }).userEmail = 'user@example.com';
    (svc as unknown as { tokenClient: unknown }).tokenClient = { requestAccessToken: () => {} };

    const start = Date.now();
    const result = await svc.trySilentRefresh();
    const elapsed = Date.now() - start;
    assert.equal(result, false, 'hung GIS must resolve false via the fallback timer');
    assert.ok(elapsed < 500, `expected to settle within refreshTimeoutMs (80) + slack; got ${elapsed}ms`);
});

test('U5: signIn is single-flight on double-click (first-sign-in path)', () => {
    clearStore();
    // First-sign-in path requires userEmail to be ABSENT in localStorage.
    // Do not set google_user_email here.

    let initCalls = 0;
    let requestCalls = 0;
    installGapiMock({});
    installGisMock({
        initTokenClient: () => {
            initCalls++;
            return {
                requestAccessToken: () => {
                    requestCalls++;
                },
            };
        },
    });

    const svc = freshService();
    // Fire two signIn calls in the same microtask. The second must be a no-op.
    void svc.signIn();
    void svc.signIn();
    // Yield so both microtasks settle; but since signIn stores a promise, both
    // synchronous calls see the same in-flight slot.
    assert.equal(initCalls, 1, 'double signIn must only invoke initTokenClient once');
    assert.equal(requestCalls, 1, 'double signIn must only invoke requestAccessToken once');
});

// 403 / PERMISSION_DENIED (scope-change / insufficient authentication scopes)
// must NOT transition the whole auth state machine to OFFLINE_AUTH. It means
// one Google API integration is missing a scope; Drive auth can still be valid
// and must not be nulled by a Tasks/Calendar-specific failure.
function installGapiMockThrowing403(api: {
    tasklistsList?: () => Promise<unknown>;
    tasksList?: () => Promise<unknown>;
    tasksInsert?: () => Promise<unknown>;
    tasksPatch?: () => Promise<unknown>;
    tasksDelete?: () => Promise<unknown>;
    calendarEventsInsert?: () => Promise<unknown>;
    calendarEventsDelete?: () => Promise<unknown>;
    errBody?: { status?: number; result?: { error?: { status?: string; code?: number; message?: string } } };
}) {
    const buildErr = (): unknown => {
        const err: { status?: number; result?: { error?: { status?: string; code?: number; message?: string } } } = {};
        if (api.errBody?.status !== undefined) err.status = api.errBody.status;
        if (api.errBody?.result) err.result = api.errBody.result;
        return err;
    };
    installGapiMock({
        tasklistsList: api.tasklistsList ?? (async () => { throw buildErr(); }),
        tasksList: api.tasksList ?? (async () => { throw buildErr(); }),
        tasksInsert: api.tasksInsert ?? (async () => { throw buildErr(); }),
        tasksPatch: api.tasksPatch ?? (async () => { throw buildErr(); }),
        tasksDelete: api.tasksDelete ?? (async () => { throw buildErr(); }),
        calendarEventsInsert: api.calendarEventsInsert ?? (async () => { throw buildErr(); }),
        calendarEventsDelete: api.calendarEventsDelete ?? (async () => { throw buildErr(); }),
    });
}

// setUserEmailInStore must be called BEFORE freshService() so the constructor
// reads userEmail from localStorage on init. Without this, getAuthState cannot
// reach the OFFLINE_AUTH branch after markAuthUnavailable clears accessToken.
function seedSignedInStorage(): void {
    localStorage.setItem('google_access_token', 'fresh-token');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');
}
function stubSilentRefresh(svc: { trySilentRefresh: () => Promise<boolean> }): void {
    svc.trySilentRefresh = async () => true;
}

test('R9: getTaskLists 403 with status:403 keeps Google auth active and returns []', async () => {
    clearStore();
    seedSignedInStorage();
    installGapiMockThrowing403({ errBody: { status: 403 } });
    const svc = freshService();
    stubSilentRefresh(svc);

    const result = await svc.getTaskLists();

    assert.deepEqual(result, [], 'getTaskLists must return [] on 403');
    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN', '403 insufficient scope must not transition global auth to OFFLINE_AUTH');
    assert.equal(svc.getAuthStatus().accessToken, 'fresh-token', '403 insufficient scope must not clear in-memory accessToken');
});

test('R9: getTasks result.error.status=PERMISSION_DENIED keeps Google auth active', async () => {
    clearStore();
    seedSignedInStorage();
    installGapiMockThrowing403({
        errBody: { result: { error: { status: 'PERMISSION_DENIED', message: 'Insufficient Authentication Scopes' } } },
    });
    const svc = freshService();
    stubSilentRefresh(svc);

    const result = await svc.getTasks('@default');

    assert.deepEqual(result, [], 'getTasks must return [] on PERMISSION_DENIED');
    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN');
});

test('R9: createGoogleTask result.error.code=403 keeps Google auth active and returns null', async () => {
    clearStore();
    seedSignedInStorage();
    installGapiMockThrowing403({
        errBody: { result: { error: { code: 403, message: 'Forbidden' } } },
    });
    const svc = freshService();
    stubSilentRefresh(svc);

    const result = await svc.createGoogleTask('Test');

    assert.equal(result, null, 'createGoogleTask must return null on 403');
    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN');
});

test('R9: updateGoogleTask 403 keeps Google auth active and returns null', async () => {
    clearStore();
    seedSignedInStorage();
    installGapiMockThrowing403({ errBody: { status: 403 } });
    const svc = freshService();
    stubSilentRefresh(svc);

    const result = await svc.updateGoogleTask('task-1', { title: 'x' });

    assert.equal(result, null, 'updateGoogleTask must return null on 403');
    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN');
});

test('R9: deleteGoogleTask PERMISSION_DENIED keeps Google auth active (void return)', async () => {
    clearStore();
    seedSignedInStorage();
    installGapiMockThrowing403({
        errBody: { result: { error: { status: 'PERMISSION_DENIED', message: 'scope' } } },
    });
    const svc = freshService();
    stubSilentRefresh(svc);

    await svc.deleteGoogleTask('task-1');

    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN');
});

test('R9: addToCalendar 403 surfaces the calendar error without clearing Google auth', async () => {
    clearStore();
    seedSignedInStorage();
    installGapiMockThrowing403({ errBody: { status: 403 } });
    const svc = freshService();
    stubSilentRefresh(svc);

    await assert.rejects(
        () => svc.addToCalendar({ title: 't', date: '2026-07-04' }),
        /Google Calendar Error/
    );

    assert.equal(svc.getAuthStatus().state, 'SIGNED_IN');
});