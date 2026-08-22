/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSyncHealth, type SyncHealth } from '../hooks/useSyncDiagnostics.ts';
import { deriveSyncVisualState } from './syncVisualState.ts';

const health = (state: SyncHealth['state']): SyncHealth => ({
    ...createSyncHealth(state, state),
    state,
});

test('disabled Hermes diagnostics do not keep an otherwise healthy sync indicator pending', () => {
    assert.equal(deriveSyncVisualState({
        authState: 'SIGNED_IN',
        isProcessing: false,
        syncHealth: {
            google: health('ok'),
            tasks: health('ok'),
            worklogs: health('ok'),
            suggestions: health('ok'),
            agentProtocol: health('disabled'),
        },
    }), 'ok');
});

test('disabled Hermes diagnostics do not mask active channel priority', () => {
    const cases: Array<[SyncHealth['state'], 'pending' | 'failed']> = [
        ['idle', 'pending'],
        ['stale', 'pending'],
        ['error', 'failed'],
    ];

    for (const [activeState, expected] of cases) {
        assert.equal(deriveSyncVisualState({
            authState: 'SIGNED_IN',
            isProcessing: false,
            syncHealth: {
                agentProtocol: health('disabled'),
                activeChannel: health(activeState),
            },
        }), expected);
    }
});

test('active work and unhealthy sync channels keep their visual priority', () => {
    assert.equal(deriveSyncVisualState({
        authState: 'REFRESH_PENDING',
        isProcessing: false,
        syncHealth: { google: health('ok') },
    }), 'pending');

    assert.equal(deriveSyncVisualState({
        authState: 'SIGNED_IN',
        isProcessing: false,
        syncHealth: { worklogs: health('stale') },
    }), 'pending');

    assert.equal(deriveSyncVisualState({
        authState: 'SIGNED_IN',
        isProcessing: true,
        syncHealth: { google: health('ok') },
    }), 'pending');

    assert.equal(deriveSyncVisualState({
        authState: 'SIGNED_IN',
        isProcessing: true,
        syncHealth: { suggestions: health('error') },
    }), 'failed');

    assert.equal(deriveSyncVisualState({
        authState: 'SIGNED_OUT',
        isProcessing: false,
        syncHealth: { google: health('ok') },
    }), 'failed');
});
