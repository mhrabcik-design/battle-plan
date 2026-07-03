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