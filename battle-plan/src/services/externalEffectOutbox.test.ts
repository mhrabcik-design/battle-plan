/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattlePlanDB, type AgentProtocolEffectRow } from '../db.ts';
import { TaskMutationService, newTaskMutationContext } from './taskMutations.ts';
import {
    ExternalEffectOutbox, createExternalEffectScheduler, executeGoogleExternalEffect, summarizeExternalEffects,
} from './externalEffectOutbox.ts';

const ACCOUNT = 'owner@example.com';
const upsert = [{ kind: 'calendar', operation: 'upsert' }] as const;
const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
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

async function googleHarness(options: { afterInsert?: () => Promise<void>; beforeWrite?: () => Promise<void> } = {}) {
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
            const id = decodeURIComponent(path.split('/').at(-1)!);
            const event = remote.get(id);
            if (method === 'GET') {
                if (!event) throw { status: 404 };
                return { status: 200, body: JSON.stringify(event) };
            }
            await options.beforeWrite?.();
            if (remote.get(id)?.etag !== headers['If-Match']) { conflicts++; throw { status: 412 }; }
            remote.set(id, method === 'DELETE' ? { etag: `"${++version}"`, status: 'cancelled' }
                : { ...JSON.parse(body), etag: `"${++version}"` });
            return { status: method === 'DELETE' ? 204 : 200, body: JSON.stringify({ id }) };
        },
    };
    Object.assign(globalThis, { localStorage: storage, window: { localStorage: storage,
        gapi: { client }, dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} } });
    const { GoogleService } = await import('./googleService.ts');
    return { service: new GoogleService(), remote, get inserts() { return inserts; }, get conflicts() { return conflicts; } };
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

test('real conditional write already in flight cannot undo successor updates after a lease expires', async (t) => {
    const db = await database(t);
    const { task, service, effectId } = await meeting(db);
    const initial = (await db.agentProtocolEffects.get(effectId))!;
    assert.equal(initial.operation, 'upsert');
    if (initial.operation !== 'upsert') throw new Error('expected upsert');
    await db.agentProtocolEffects.put({ ...initial, payload: { ...initial.payload, googleEventId: task.reservedGoogleEventId } });
    let now = 100;
    const entered = deferred();
    const release = deferred();
    let writes = 0;
    const google = await googleHarness({ beforeWrite: async () => {
        if (++writes === 1) { entered.resolve(); await release.promise; }
    } });
    google.remote.set(task.reservedGoogleEventId!, { etag: '"original"', summary: 'Original' });
    const options = { accountId: () => ACCOUNT, now: () => now, leaseDurationMs: 100, scheduleRenewal: () => () => {},
        execute: (effect: AgentProtocolEffectRow, guard: { isCurrent: () => Promise<boolean> }) => executeGoogleExternalEffect(google.service, effect, guard) };
    const old = new ExternalEffectOutbox(db, options).drainOnce();
    await entered.promise;
    await service.updateTask({ localId: task.id, changes: { title: 'Latest', internalNotes: 'Latest private notes' },
        context: newTaskMutationContext('ui'), effects: [...upsert] });
    now = 201;
    assert.equal((await new ExternalEffectOutbox(db, options).drainOnce()).succeeded, 2);
    release.resolve();
    assert.equal((await old).succeeded, 0);
    assert.equal(google.conflicts, 1, 'Google rejects the late stale ETag');
    assert.equal(google.remote.get(task.reservedGoogleEventId!)?.summary, 'Latest [BP]');
    assert.match(google.remote.get(task.reservedGoogleEventId!)?.description ?? '', /Latest private notes/);
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
