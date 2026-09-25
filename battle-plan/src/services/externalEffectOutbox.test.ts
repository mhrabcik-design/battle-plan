/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { BattlePlanDB, type AgentProtocolEffectRow } from '../db.ts';
import { TaskMutationService, newTaskMutationContext } from './taskMutations.ts';
import {
    ExternalEffectOutbox, createExternalEffectScheduler, executeGoogleExternalEffect, summarizeExternalEffects,
} from './externalEffectOutbox.ts';

const ACCOUNT = 'owner@example.com';
const upsert = [{ kind: 'calendar', operation: 'upsert' }] as const;
const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
async function database(t: { after: (fn: () => Promise<void>) => void }) {
    const db = new BattlePlanDB(`Effects-${crypto.randomUUID()}`);
    await db.open();
    t.after(() => db.delete());
    return db;
}
async function meeting(db: BattlePlanDB, account: string | undefined = ACCOUNT) {
    const service = new TaskMutationService(db);
    const result = await service.createTask({
        task: { title: 'First', status: 'pending', type: 'meeting', urgency: 2, date: '2026-09-20' },
        context: newTaskMutationContext('ui', undefined, account), effects: [...upsert],
    });
    assert.equal(result.status, 'applied');
    if (result.status !== 'applied') throw new Error('create failed');
    return { service, task: result.task, effectId: result.effectIds[0] };
}
const target = (effect: AgentProtocolEffectRow) => effect.kind === 'calendar' && effect.operation === 'upsert'
    ? effect.payload.reservedEventId : undefined;

test('a retry and a filtered drain cannot overtake an older edit, while another task progresses', async (t) => {
    const db = await database(t);
    const { task, service, effectId } = await meeting(db);
    await service.updateTask({ localId: task.id, changes: { title: 'Second' },
        context: newTaskMutationContext('ui'), effects: [...upsert] });
    const effects = (await db.agentProtocolEffects.toArray()).sort((a, b) => a.sequence - b.sequence);
    await meeting(db);
    let now = 100;
    const calls: string[] = [];
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now,
        execute: async (effect) => { calls.push(effect.id); if (effect.id === effectId) throw { status: 503 }; return { externalId: target(effect) }; },
    });
    assert.equal((await worker.drainOnce([effects[1].id])).attempted, 0);
    assert.equal((await worker.drainOnce()).succeeded, 1);
    assert.equal(calls.includes(effects[1].id), false);
    now = 200;
    assert.equal((await worker.drainOnce()).attempted, 0);
    assert.equal((await db.agentProtocolEffects.get(effectId))?.state, 'retry_scheduled');
});

test('auth, scope, transient and precondition failures retry indefinitely with a capped delay', async (t) => {
    const db = await database(t);
    const { effectId } = await meeting(db);
    let now = 1_000;
    let status = 401;
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now,
        execute: async () => { throw { status }; },
    });
    for (status of [401, 403, 429, 500, 503, 412, 401, 503, 503, 503, 503, 503]) {
        assert.equal((await worker.drainOnce()).retryScheduled, 1);
        const effect = (await db.agentProtocolEffects.get(effectId))!;
        assert.equal(effect.state, 'retry_scheduled');
        assert.ok(effect.nextAttemptAt! - now <= 60_000);
        now = effect.nextAttemptAt!;
    }
});

test('offline, unbound and mismatched accounts pause durably; reopen and auth recovery deliver', async (t) => {
    const db = await database(t);
    const { effectId } = await meeting(db);
    await meeting(db, 'other@example.com');
    const unbound = await meeting(db, undefined);
    await db.agentProtocolEffects.update(unbound.effectId, { accountId: undefined });
    let online = false;
    let account: string | null = ACCOUNT;
    const calls: string[] = [];
    const worker = new ExternalEffectOutbox(db, { accountId: () => account, canExecute: () => online,
        execute: async (effect) => { calls.push(effect.id); return { externalId: target(effect) }; },
    });
    assert.equal((await worker.drainOnce()).attempted, 0);
    online = true;
    account = null;
    assert.equal((await worker.drainOnce()).attempted, 0);
    db.close();
    await db.open();
    account = ACCOUNT;
    assert.equal((await worker.drainOnce()).succeeded, 1);
    assert.deepEqual(calls, [effectId]);
    const summary = summarizeExternalEffects(await db.agentProtocolEffects.toArray(), ACCOUNT);
    assert.equal(summary.pending, 2);
    assert.equal(summary.accountBlocked, 2);
});

test('a permanent failure remains inspectable but a corrected successor can succeed', async (t) => {
    const db = await database(t);
    const { service, task, effectId } = await meeting(db);
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT,
        execute: async (effect) => { if (effect.id === effectId) throw { status: 400 }; return { externalId: target(effect) }; },
    });
    assert.equal((await worker.drainOnce()).failed, 1);
    assert.equal(summarizeExternalEffects(await db.agentProtocolEffects.toArray(), ACCOUNT).failed, 1);
    await service.updateTask({ localId: task.id, changes: { title: 'Corrected' },
        context: newTaskMutationContext('ui'), effects: [...upsert] });
    assert.equal((await worker.drainOnce()).succeeded, 1);
    assert.equal((await db.agentProtocolEffects.get(effectId))?.state, 'failed');
    assert.equal(summarizeExternalEffects(await db.agentProtocolEffects.toArray(), ACCOUNT).failed, 0);
});

test('switching accounts during a request preparation revokes its guard and recovery keeps its original destination', async (t) => {
    const db = await database(t);
    const { effectId } = await meeting(db);
    let account = ACCOUNT;
    let writes = 0;
    const entered = deferred();
    const release = deferred();
    const worker = new ExternalEffectOutbox(db, { accountId: () => account,
        execute: async (effect, guard) => {
            entered.resolve();
            await release.promise;
            if (!await guard.isCurrent()) throw new Error('account unavailable');
            writes++;
            return { externalId: target(effect) };
        },
    });
    const pending = worker.drainOnce();
    await entered.promise;
    account = 'different@example.com';
    release.resolve();
    assert.equal((await pending).retryScheduled, 1);
    assert.equal(writes, 0);
    await db.agentProtocolEffects.update(effectId, { nextAttemptAt: 0 });
    assert.equal((await worker.drainOnce()).attempted, 0);
    account = ACCOUNT;
    assert.equal((await worker.drainOnce()).succeeded, 1);
    assert.equal(writes, 1);
});

test('a stalled request renews its claim and competing workers cannot overtake it', async (t) => {
    const db = await database(t);
    const { effectId } = await meeting(db);
    let now = 1_000;
    let heartbeat: (() => Promise<void>) | undefined;
    const entered = deferred();
    const release = deferred();
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now, leaseDurationMs: 100,
        scheduleRenewal: (callback) => { heartbeat = callback; return () => { heartbeat = undefined; }; },
        execute: async (effect) => { entered.resolve(); await release.promise; return { externalId: target(effect) }; },
    });
    const draining = worker.drainOnce();
    await entered.promise;
    now = 1_080;
    await heartbeat!();
    assert.equal((await db.agentProtocolEffects.get(effectId))?.leaseExpiresAt, 1_180);
    now = 1_120;
    const competitor = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now,
        execute: async () => { throw new Error('must not execute'); },
    });
    assert.equal((await competitor.drainOnce()).attempted, 0);
    release.resolve();
    assert.equal((await draining).succeeded, 1);
    assert.equal(heartbeat, undefined);
});

test('an execution deadline releases a hung drain and later task changes progress without reloading', { timeout: 2_000 }, async (t) => {
    const db = await database(t);
    const { effectId } = await meeting(db);
    let stopped = 0;
    let heartbeat!: () => Promise<void>;
    let expiredGuard!: () => Promise<boolean>;
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, executionTimeoutMs: 20,
        scheduleRenewal: (callback) => { heartbeat = callback; return () => { stopped++; }; },
        execute: async (effect, guard) => {
            if (effect.id !== effectId) return { externalId: target(effect) };
            expiredGuard = guard.isCurrent;
            return new Promise(() => {});
        },
    });
    assert.equal((await worker.drainOnce()).retryScheduled, 1);
    assert.equal(stopped, 1);
    assert.equal(await expiredGuard(), false);
    const timedOut = (await db.agentProtocolEffects.get(effectId))!;
    assert.equal(timedOut.state, 'retry_scheduled');
    assert.equal(timedOut.leaseExpiresAt, undefined);
    await heartbeat();
    assert.deepEqual(await db.agentProtocolEffects.get(effectId), timedOut, 'a queued heartbeat cannot revive an expired attempt');
    const later = await meeting(db);
    assert.equal((await worker.drainOnce()).succeeded, 1);
    assert.equal((await db.agentProtocolEffects.get(later.effectId))?.state, 'succeeded');
});

test('late resolution and rejection after a deadline cannot replace a retry or newer result', { timeout: 2_000 }, async (t) => {
    for (const scenario of ['resolve-before-retry', 'reject-before-retry', 'resolve-after-success', 'reject-after-success']) {
        await t.test(scenario, async (subtest) => {
            const db = await database(subtest);
            const { task, effectId } = await meeting(db);
            const release = deferred<{ externalId?: string }>();
            let now = 100;
            const expired = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now,
                executionTimeoutMs: 20, execute: () => release.promise,
            });
            assert.equal((await expired.drainOnce()).retryScheduled, 1);
            assert.equal((await db.tasks.get(task.id!))?.googleEventId, undefined);
            const retry = (await db.agentProtocolEffects.get(effectId))!;
            const settle = async () => {
                if (scenario.startsWith('resolve')) release.resolve({ externalId: task.reservedGoogleEventId });
                else release.reject({ status: 400 });
                await setImmediate();
            };
            if (scenario.endsWith('before-retry')) {
                await settle();
                assert.deepEqual(await db.agentProtocolEffects.get(effectId), retry);
                assert.equal((await db.tasks.get(task.id!))?.googleEventId, undefined);
            }
            now = retry.nextAttemptAt!;
            const successor = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now,
                execute: async (effect) => ({ externalId: target(effect) }),
            });
            assert.equal((await successor.drainOnce()).succeeded, 1);
            const completed = await db.agentProtocolEffects.get(effectId);
            const completedTask = await db.tasks.get(task.id!);
            if (scenario.endsWith('after-success')) await settle();
            assert.deepEqual(await db.agentProtocolEffects.get(effectId), completed);
            assert.deepEqual(await db.tasks.get(task.id!), completedTask);
        });
    }
});

test('a deadline invalidates a guard whose ownership read was already in flight', { timeout: 2_000 }, async (t) => {
    const db = await database(t);
    await meeting(db);
    const readEntered = deferred();
    const releaseRead = deferred();
    const executorFinished = deferred();
    const originalGet = db.agentProtocolEffects.get.bind(db.agentProtocolEffects);
    let pauseRead = false;
    t.mock.method(db.agentProtocolEffects, 'get', (id: string) => {
        const read = originalGet(id);
        if (!pauseRead) return read;
        pauseRead = false;
        return read.then(async (snapshot) => {
            readEntered.resolve();
            await releaseRead.promise;
            return snapshot;
        });
    });
    let writes = 0;
    let lateGuard: boolean | undefined;
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, executionTimeoutMs: 30,
        execute: async (effect, guard) => {
            pauseRead = true;
            lateGuard = await guard.isCurrent();
            if (lateGuard) writes++;
            executorFinished.resolve();
            return { externalId: target(effect) };
        },
    });
    const draining = worker.drainOnce();
    await readEntered.promise;
    assert.equal((await draining).retryScheduled, 1);
    releaseRead.resolve();
    await executorFinished.promise;
    assert.equal(lateGuard, false, 'an old running snapshot does not restore the expired local guard');
    assert.equal(writes, 0);
});

test('a heartbeat reading ownership when the deadline expires cannot extend the lease', async (t) => {
    const db = await database(t);
    await meeting(db);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entered = deferred();
    let now = 100;
    let heartbeat!: () => Promise<void>;
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now, executionTimeoutMs: 20,
        scheduleRenewal: (callback) => { heartbeat = callback; return () => {}; },
        execute: () => { entered.resolve(); return new Promise(() => {}); },
    });
    const draining = worker.drainOnce();
    await entered.promise;
    let pauseRead = true;
    const originalGet = db.agentProtocolEffects.get.bind(db.agentProtocolEffects);
    t.mock.method(db.agentProtocolEffects, 'get', (id: string) => {
        const read = originalGet(id);
        if (!pauseRead) return read;
        pauseRead = false;
        return read.then((snapshot) => { t.mock.timers.tick(20); return snapshot; });
    });
    let renewals = 0;
    db.agentProtocolEffects.hook('updating', (changes: Partial<AgentProtocolEffectRow>) => {
        if (changes.leaseExpiresAt !== undefined) renewals++;
    });
    now = 150;
    await heartbeat();
    assert.equal((await draining).retryScheduled, 1);
    assert.equal(renewals, 0);
});

test('a backlog uses at most four entity workers and preserves FIFO within every task', { timeout: 5_000 }, async (t) => {
    const db = await database(t);
    for (let i = 0; i < 12; i++) {
        const { service, task } = await meeting(db);
        await service.updateTask({ localId: task.id, changes: { title: `Later ${i}` },
            context: newTaskMutationContext('ui'), effects: [...upsert] });
    }
    const release = deferred();
    const fourEntered = deferred();
    const activeEntities = new Set<string>();
    const sequences = new Map<string, number[]>();
    let peak = 0;
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT,
        scheduleRenewal: () => () => {},
        execute: async (effect) => {
            assert.equal(activeEntities.has(effect.entityPublicId), false);
            activeEntities.add(effect.entityPublicId);
            peak = Math.max(peak, activeEntities.size);
            const order = sequences.get(effect.entityPublicId) ?? [];
            order.push(effect.sequence);
            sequences.set(effect.entityPublicId, order);
            if (activeEntities.size === 4) fourEntered.resolve();
            await release.promise;
            activeEntities.delete(effect.entityPublicId);
            return { externalId: target(effect) };
        },
    });
    const draining = worker.drainOnce();
    try {
        await fourEntered.promise;
        await db.agentProtocolEffects.toArray();
        assert.equal(peak, 4);
    } finally {
        release.resolve();
        assert.equal((await draining).succeeded, 24);
    }
    assert.equal(peak, 4);
    assert.equal(sequences.size, 12);
    for (const order of sequences.values()) assert.deepEqual(order, [1, 2]);
});

test('an expired delayed claim cannot acknowledge or pass its remote guard after another worker succeeds', async (t) => {
    const db = await database(t);
    const { task, effectId, service } = await meeting(db);
    let now = 100;
    const entered = deferred();
    const release = deferred();
    let lateGuard: boolean | undefined;
    const oldWorker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now, leaseDurationMs: 100,
        scheduleRenewal: () => () => {},
        execute: async (effect, guard) => { entered.resolve(); await release.promise; lateGuard = await guard.isCurrent(); return { externalId: target(effect) }; },
    });
    const oldRun = oldWorker.drainOnce();
    await entered.promise;
    await service.updateTask({ localId: task.id, changes: { title: 'Newer' },
        context: newTaskMutationContext('ui'), effects: [...upsert] });
    now = 201;
    const next = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, now: () => now,
        execute: async (effect) => ({ externalId: target(effect) }),
    });
    assert.equal((await next.drainOnce()).succeeded, 2);
    release.resolve();
    assert.equal((await oldRun).succeeded, 0);
    assert.equal(lateGuard, false);
    assert.equal((await db.agentProtocolEffects.get(effectId))?.fencingToken, 2);
    assert.equal((await db.tasks.get(task.id!))?.title, 'Newer');
});

test('metadata and success roll back together, and delayed success cannot resurrect a removed task', async (t) => {
    const db = await database(t);
    const { task, effectId } = await meeting(db);
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT,
        execute: async (effect) => ({ externalId: target(effect) }),
    });
    const fail = (changes: Partial<AgentProtocolEffectRow>) => { if (changes.state === 'succeeded') throw new Error('ack failure'); };
    db.agentProtocolEffects.hook('updating', fail);
    assert.equal((await worker.drainOnce()).retryScheduled, 1);
    db.agentProtocolEffects.hook('updating').unsubscribe(fail);
    assert.equal((await db.tasks.get(task.id!))?.googleEventId, undefined);
    assert.equal((await db.agentProtocolEffects.get(effectId))?.state, 'retry_scheduled');
    await db.agentProtocolEffects.update(effectId, { nextAttemptAt: 0 });
    const entered = deferred();
    const release = deferred();
    const delayed = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT,
        execute: async (effect) => { entered.resolve(); await release.promise; return { externalId: target(effect) }; },
    });
    const draining = delayed.drainOnce();
    await entered.promise;
    await db.tasks.delete(task.id!);
    release.resolve();
    assert.equal((await draining).succeeded, 1);
    assert.equal(await db.tasks.get(task.id!), undefined);
});

test('Google adapter returning unavailable never reports a calendar delete or Tasks completion as success', async (t) => {
    const db = await database(t);
    const { task, service } = await meeting(db);
    await service.archiveTask({ localId: task.id, context: newTaskMutationContext('ui'),
        effects: [{ kind: 'calendar', operation: 'delete' }] });
    const deletion = (await db.agentProtocolEffects.toArray()).find((effect) => effect.operation === 'delete')!;
    const client = { addToCalendar: async () => undefined, deleteFromCalendar: async () => undefined,
        updateGoogleTask: async () => null };
    await assert.rejects(executeGoogleExternalEffect(client, deletion, { isCurrent: async () => true }), /unavailable/);
    const completion: AgentProtocolEffectRow = { ...deletion, kind: 'google_tasks', operation: 'complete', payload: { googleTaskId: 'g1' } };
    await assert.rejects(executeGoogleExternalEffect(client, completion, { isCurrent: async () => true }), /unavailable/);
});

async function googleHarness(options: {
    afterInsert?: () => Promise<void>; beforeGet?: () => Promise<void>; beforeWrite?: () => Promise<void>;
} = {}) {
    const values = new Map([['google_access_token', 'token'], ['google_token_expires_at', String(Date.now() + 3_600_000)],
        ['google_user_email', ACCOUNT]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key) };
    const remote = new Map<string, { etag: string; summary?: string; description?: string; status?: string }>();
    let version = 0;
    let inserts = 0;
    let conflicts = 0;
    const client = {
        setToken: () => {},
        calendar: { events: { insert: async ({ resource }: { resource: { id: string; summary: string; description: string } }) => {
            inserts++;
            if (remote.has(resource.id)) throw { status: 409 };
            remote.set(resource.id, { ...resource, etag: `"${++version}"` });
            await options.afterInsert?.();
            return { result: { id: resource.id } };
        } } },
        request: async ({ path, method, headers, body }: { path: string; method: string; headers: Record<string, string>; body: string }) => {
            const id = decodeURIComponent(path.split('?')[0].split('/').at(-1)!);
            const event = remote.get(id);
            if (method === 'GET') {
                if (!event) throw { status: 404 };
                await options.beforeGet?.();
                return { status: 200, body: JSON.stringify(event) };
            }
            await options.beforeWrite?.();
            if (remote.get(id)?.etag !== headers['If-Match']) { conflicts++; throw { status: 412 }; }
            remote.set(id, method === 'DELETE' ? { etag: `"${++version}"`, status: 'cancelled' }
                : { ...remote.get(id), ...JSON.parse(body), etag: `"${++version}"` });
            return { status: method === 'DELETE' ? 204 : 200, body: JSON.stringify({ id }) };
        },
    };
    Object.assign(globalThis, { localStorage: storage,
        fetch: async (url: string) => {
            assert.equal(url, 'https://www.googleapis.com/oauth2/v3/userinfo');
            return { ok: true, json: async () => ({ email: ACCOUNT }) };
        }, window: { localStorage: storage,
        gapi: { client }, dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} } });
    const { GoogleService } = await import('./googleService.ts');
    const service = new GoogleService();
    await service.fetchUserInfo();
    return { service, remote, get inserts() { return inserts; }, get conflicts() { return conflicts; } };
}

test('real guarded adapter delivers queued create, edit and archive against one reserved event', async (t) => {
    const db = await database(t);
    const { task, service } = await meeting(db);
    const entered = deferred();
    const release = deferred();
    const google = await googleHarness({ afterInsert: async () => { entered.resolve(); await release.promise; } });
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT,
        execute: (effect, guard) => executeGoogleExternalEffect(google.service, effect, guard),
    });
    const first = worker.drainOnce();
    await entered.promise;
    await service.updateTask({ localId: task.id, changes: { title: 'Latest', internalNotes: 'Notes', totalDuration: 60 },
        context: newTaskMutationContext('ui'), effects: [...upsert] });
    await service.archiveTask({ localId: task.id, context: newTaskMutationContext('ui'), effects: [{ kind: 'calendar', operation: 'delete' }] });
    assert.equal((await worker.drainOnce()).attempted, 0, 'no successor while create is in flight');
    release.resolve();
    assert.equal((await first).succeeded, 1);
    assert.equal((await worker.drainOnce()).succeeded, 2);
    assert.equal(google.remote.size, 1);
    assert.equal(google.inserts, 2, 'the repeated reserved insert uses 409 + conditional update');
    assert.equal(google.remote.get(task.reservedGoogleEventId!)?.status, 'cancelled');
    const latest = (await db.tasks.get(task.id!))!;
    assert.equal(latest.isDeleted, true);
    assert.equal(latest.title, 'Latest');
    assert.equal(latest.googleEventId, undefined, 'late acknowledgements never attach metadata to archived tasks');
});

test('a real Calendar GET completing after the deadline cannot send a follow-up write', { timeout: 2_000 }, async (t) => {
    const db = await database(t);
    const { task, effectId } = await meeting(db);
    const initial = (await db.agentProtocolEffects.get(effectId))!;
    if (initial.operation !== 'upsert') throw new Error('expected upsert');
    await db.agentProtocolEffects.put({ ...initial, payload: { ...initial.payload, googleEventId: task.reservedGoogleEventId } });
    const entered = deferred();
    const release = deferred();
    const executionFinished = deferred();
    let writes = 0;
    const google = await googleHarness({ beforeGet: async () => { entered.resolve(); await release.promise; },
        beforeWrite: async () => { writes++; },
    });
    google.remote.set(task.reservedGoogleEventId!, { etag: '"original"', summary: 'Original' });
    const worker = new ExternalEffectOutbox(db, { accountId: () => ACCOUNT, executionTimeoutMs: 30,
        execute: (effect, guard) => executeGoogleExternalEffect(google.service, effect, guard).finally(() => executionFinished.resolve()),
    });
    const draining = worker.drainOnce();
    await entered.promise;
    assert.equal((await draining).retryScheduled, 1);
    release.resolve();
    await executionFinished.promise;
    assert.equal(writes, 0);
    assert.equal(google.remote.get(task.reservedGoogleEventId!)?.summary, 'Original');
    assert.equal((await db.agentProtocolEffects.get(effectId))?.state, 'retry_scheduled');
});

test('real conditional write already in flight cannot undo successor updates after its deadline', async (t) => {
    const db = await database(t);
    const { task, service, effectId } = await meeting(db);
    const initial = (await db.agentProtocolEffects.get(effectId))!;
    assert.equal(initial.operation, 'upsert');
    if (initial.operation !== 'upsert') throw new Error('expected upsert');
    await db.agentProtocolEffects.put({ ...initial, payload: { ...initial.payload, googleEventId: task.reservedGoogleEventId } });
    let now = 100;
    const entered = deferred();
    const release = deferred();
    const executionFinished = deferred();
    let writes = 0;
    const google = await googleHarness({ beforeWrite: async () => {
        if (++writes === 1) { entered.resolve(); await release.promise; }
    } });
    google.remote.set(task.reservedGoogleEventId!, { etag: '"original"', summary: 'Original' });
    const options = { accountId: () => ACCOUNT, now: () => now, leaseDurationMs: 100, scheduleRenewal: () => () => {},
        execute: (effect: AgentProtocolEffectRow, guard: { isCurrent: () => Promise<boolean> }) => executeGoogleExternalEffect(google.service, effect, guard) };
    const old = new ExternalEffectOutbox(db, { ...options, executionTimeoutMs: 30,
        execute: (effect, guard) => options.execute(effect, guard).finally(() => executionFinished.resolve()),
    }).drainOnce();
    await entered.promise;
    await service.updateTask({ localId: task.id, changes: { title: 'Latest', internalNotes: 'Latest private notes' },
        context: newTaskMutationContext('ui'), effects: [...upsert] });
    assert.equal((await old).retryScheduled, 1);
    now = (await db.agentProtocolEffects.get(effectId))!.nextAttemptAt!;
    assert.equal((await new ExternalEffectOutbox(db, options).drainOnce()).succeeded, 2);
    release.resolve();
    await executionFinished.promise;
    assert.equal(google.conflicts, 1, 'Google rejects the late stale ETag');
    assert.equal(google.remote.get(task.reservedGoogleEventId!)?.summary, 'Latest [BP]');
    assert.doesNotMatch(google.remote.get(task.reservedGoogleEventId!)?.description ?? '', /Latest private notes/);
    assert.equal((await db.tasks.get(task.id!))?.title, 'Latest');
});

test('scheduler coalesces work, resumes enabled work, and teardown stops future scheduling without cancelling sends', async () => {
    const release = deferred();
    const timers = new Set<() => void>();
    let calls = 0;
    const scheduler = createExternalEffectScheduler({ drain: async () => { calls++; await release.promise; },
        schedule: (callback) => { timers.add(callback); return () => { timers.delete(callback); }; },
    });
    await scheduler.wake();
    assert.equal(calls, 0);
    scheduler.setEnabled(true);
    await Promise.resolve();
    assert.equal(calls, 1);
    void scheduler.wake();
    scheduler.stop();
    release.resolve();
    await scheduler.wake();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(timers.size, 0);
});
