/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProtocolPollingCoordinator } from '../services/agentProtocol/pollingCoordinator.ts';
import {
    startAgentProtocolPolling,
    type ProtocolPollingScheduler,
} from './useAgentProtocolPolling.ts';

class FakeEventTarget {
    private readonly listeners = new Map<string, Set<() => void>>();

    addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener();
    }

    count(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }
}

test('polling hook schedule deduplicates overlapping triggers and cleans up every source', async () => {
    const timeouts: Array<() => void> = [];
    const intervals: Array<() => void> = [];
    const cleared = { timeout: 0, interval: 0 };
    const scheduler: ProtocolPollingScheduler = {
        setTimeout: (callback) => (timeouts.push(callback), callback),
        clearTimeout: () => { cleared.timeout += 1; },
        setInterval: (callback) => (intervals.push(callback), callback),
        clearInterval: () => { cleared.interval += 1; },
    };
    const documentTarget = new FakeEventTarget();
    const windowTarget = new FakeEventTarget();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const stop = startAgentProtocolPolling({
        receiverId: 'receiver-a',
        poll: async () => { calls += 1; await gate; },
        coordinator: createProtocolPollingCoordinator(),
        scheduler,
        documentTarget,
        windowTarget,
    });

    timeouts[0]!();
    intervals[0]!();
    documentTarget.dispatch('visibilitychange');
    windowTarget.dispatch('focus');
    await Promise.resolve();
    assert.equal(calls, 1);

    stop();
    assert.deepEqual(cleared, { timeout: 1, interval: 1 });
    assert.equal(documentTarget.count('visibilitychange'), 0);
    assert.equal(windowTarget.count('focus'), 0);
    windowTarget.dispatch('focus');
    release();
    await Promise.resolve();
    assert.equal(calls, 1);
});

test('poll rejection after cleanup does not report a stale UI error', async () => {
    let trigger!: () => void;
    const scheduler: ProtocolPollingScheduler = {
        setTimeout: (callback) => (trigger = callback),
        clearTimeout: () => undefined,
        setInterval: () => undefined,
        clearInterval: () => undefined,
    };
    let rejectPoll!: (error: Error) => void;
    const poll = new Promise<void>((_resolve, reject) => { rejectPoll = reject; });
    const errors: unknown[] = [];
    const stop = startAgentProtocolPolling({
        receiverId: 'receiver-a',
        poll: () => poll,
        coordinator: createProtocolPollingCoordinator(),
        scheduler,
        onError: (error) => errors.push(error),
    });

    trigger();
    await Promise.resolve();
    stop();
    rejectPoll(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(errors, []);
});
