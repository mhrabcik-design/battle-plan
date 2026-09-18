/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskBackupCoordinator, hydrateTaskBackup, type TaskBackupSnapshot } from './taskBackupCoordinator.ts';
import type { TaskDriveBackupLoadResult } from '../services/taskDriveBackup.ts';

const snapshot = (revision: string): TaskBackupSnapshot => ({ revision, data: { settings: [{ id: 'setting', value: revision }], tasks: [] } });
const deferred = () => {
    let resolve!: (value: number | null) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<number | null>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
function setup(save: (data: TaskBackupSnapshot['data']) => Promise<number | null>) {
    const timers = new Set<() => void>();
    const saved: number[] = [];
    const errors: unknown[] = [];
    const coordinator = createTaskBackupCoordinator({
        save, onSaved: (timestamp) => { saved.push(timestamp); }, onError: (error) => { errors.push(error); },
        schedule: (callback) => { timers.add(callback); return callback as unknown as ReturnType<typeof setTimeout>; },
        clear: (timer) => { timers.delete(timer as unknown as () => void); },
    });
    return { coordinator, timers, saved, errors };
}

test('backup waits for auth and successful hydration, preserves dirty changes and never overlaps saves', async () => {
    const first = deferred();
    const calls: string[] = [];
    const { coordinator, timers, saved } = setup(async (data) => {
        calls.push(data.settings![0].value);
        return calls.length === 1 ? first.promise : 200;
    });
    coordinator.update(snapshot('a'), false);
    await coordinator.flush();
    assert.deepEqual(calls, []);
    assert.equal(timers.size, 0);
    coordinator.update(snapshot('a'), true);
    const pending = coordinator.flush();
    await Promise.resolve();
    coordinator.update(snapshot('b'), true);
    await coordinator.flush();
    assert.deepEqual(calls, ['a']);
    first.resolve(100);
    await pending;
    assert.equal(timers.size, 1);
    await coordinator.flush();
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(saved, [100, 200]);
    coordinator.update(snapshot('b'), true);
    await coordinator.flush();
    assert.equal(calls.length, 2, 'same data / navigation does not upload again');
    coordinator.stop();
});

test('failure releases backup guard and retries; teardown suppresses stale callbacks and further writes', async () => {
    const first = deferred();
    let calls = 0;
    const { coordinator, errors, saved, timers } = setup(async () => ++calls === 1 ? first.promise : 200);
    coordinator.update(snapshot('a'), true);
    const pending = coordinator.flush();
    await Promise.resolve();
    first.reject(new Error('offline'));
    await pending;
    assert.equal(errors.length, 1);
    await coordinator.flush();
    assert.equal(calls, 2);
    assert.deepEqual(saved, [200]);
    coordinator.update(snapshot('b'), true);
    coordinator.stop();
    await coordinator.flush();
    assert.equal(calls, 2);
    assert.equal(timers.size, 0);
});

test('sign-out disables a pending follow-up and callbacks; new instances wait for old requests', async () => {
    const gate = deferred();
    const old = setup(() => gate.promise);
    old.coordinator.update(snapshot('old'), true);
    const oldPending = old.coordinator.flush();
    await Promise.resolve();
    old.coordinator.update(snapshot('newer'), false);
    old.coordinator.stop();
    let newCalls = 0;
    const next = setup(async () => { newCalls++; return 300; });
    next.coordinator.update(snapshot('next'), true);
    const nextPending = next.coordinator.flush();
    await Promise.resolve();
    assert.equal(newCalls, 0);
    gate.resolve(100);
    await Promise.all([oldPending, nextPending]);
    assert.deepEqual(old.saved, []);
    assert.deepEqual(old.errors, []);
    assert.equal(newCalls, 1);
    next.coordinator.stop();
});

test('first backup waits for remote loading AND merging; failed reads never publish readiness', async () => {
    let releaseLoad!: (result: TaskDriveBackupLoadResult) => void;
    let releaseMerge!: () => void;
    const loading = new Promise<TaskDriveBackupLoadResult>((resolve) => { releaseLoad = resolve; });
    const merging = new Promise<void>((resolve) => { releaseMerge = resolve; });
    let saves = 0;
    const { coordinator } = setup(async () => ++saves);
    coordinator.update(snapshot('local'), false);
    const hydration = hydrateTaskBackup(() => loading, () => merging, () => true)
        .then(({ ready }) => { coordinator.update(snapshot('merged'), ready); });
    await coordinator.flush();
    assert.equal(saves, 0);
    releaseLoad({ kind: 'loaded', payload: { data: { tasks: [] } } });
    await Promise.resolve();
    await coordinator.flush();
    assert.equal(saves, 0);
    releaseMerge();
    await hydration;
    await coordinator.flush();
    assert.equal(saves, 1);
    coordinator.stop();

    for (const result of [
        { kind: 'error', message: 'Network failure' },
        { kind: 'store-unavailable', status: { code: 'auth-unavailable', message: 'Login required' } },
    ] as TaskDriveBackupLoadResult[]) {
        const { ready } = await hydrateTaskBackup(async () => result, async () => assert.fail('must not merge failed load'), () => true);
        assert.equal(ready, false);
    }
    assert.equal((await hydrateTaskBackup(async () => ({ kind: 'missing-file' }), async () => undefined, () => true)).ready, true);
    await assert.rejects(hydrateTaskBackup(async () => ({ kind: 'loaded', payload: {} }), async () => { throw new Error('merge failed'); }, () => true), /merge failed/);
    assert.equal((await hydrateTaskBackup(async () => ({ kind: 'loaded', payload: {} }), async () => assert.fail('cancelled'), () => false)).ready, false);
});
