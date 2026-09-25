/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattlePlanDB, type AgentProtocolEffectRow, type Task } from '../db.ts';
import { TaskMutationService, newTaskMutationContext } from './taskMutations.ts';
import { ExternalEffectOutbox } from './externalEffectOutbox.ts';
import { prepareCalendarInvitation } from './calendarInvitation.ts';

const ACCOUNT = 'owner@example.com';
async function setup(t: { after: (fn: () => Promise<void>) => void }, changes: Partial<Task> = {}) {
    const db = new BattlePlanDB(`Invitation-${crypto.randomUUID()}`);
    await db.open();
    t.after(() => db.delete());
    const mutations = new TaskMutationService(db);
    const created = await mutations.createTask({ task: { title: 'Meeting', type: 'meeting', status: 'pending',
        urgency: 2, date: '2026-09-25', startTime: '09:30', duration: 30, ...changes }, context: newTaskMutationContext('ui') });
    assert.equal(created.status, 'applied');
    if (created.status !== 'applied') throw new Error('create failed');
    let account: string | null = ACCOUNT;
    const calls: AgentProtocolEffectRow[] = [];
    let execute = async (effect: AgentProtocolEffectRow) => {
        calls.push(effect);
        return { externalId: effect.kind === 'calendar' && effect.operation === 'upsert'
            ? effect.payload.googleEventId ?? effect.payload.reservedEventId : undefined };
    };
    const worker = new ExternalEffectOutbox(db, { accountId: () => account, execute: (effect) => execute(effect) });
    const links: string[] = [];
    const dependencies = { db, mutations, accountId: () => account, canExecute: () => true,
        drain: (ids: readonly string[]) => worker.drainOnce(ids),
        getLink: async (id: string) => { links.push(id); return `https://calendar.google.com/calendar/event?eid=${id}`; } };
    return { db, mutations, task: created.task, dependencies, calls, links,
        switchAccount: () => { account = 'other@example.com'; }, setExecute: (fn: typeof execute) => { execute = fn; } };
}

test('prepares a new event, drains predecessors, and reuses the same event on repeat', async (t) => {
    const s = await setup(t);
    await s.mutations.queueEffects({ localId: s.task.id, context: newTaskMutationContext('ui', undefined, ACCOUNT),
        effects: [{ kind: 'calendar', operation: 'upsert' }] });
    await s.mutations.updateTask({ localId: s.task.id, changes: { title: 'Latest' }, context: newTaskMutationContext('ui') });
    const current = (await s.db.tasks.get(s.task.id!))!;
    const first = await prepareCalendarInvitation(current, s.dependencies);
    const second = await prepareCalendarInvitation(current, s.dependencies);
    assert.equal(first, second);
    assert.equal(s.calls.length, 3);
    assert.ok('title' in s.calls[1].payload);
    assert.equal(s.calls[1].payload.title, 'Latest');
    assert.equal(new Set(s.links).size, 1);
});

test('existing linked event is synchronized before reading its link', async (t) => {
    const s = await setup(t, { googleEventId: 'existing', googleAccountId: ACCOUNT });
    await prepareCalendarInvitation(s.task, s.dependencies);
    assert.deepEqual(s.links, ['existing']);
    assert.equal(s.calls.length, 1);
});

for (const changes of [{ date: undefined }, { date: '2026-02-30' }, { startTime: '24:00' }, { duration: 0 }, { status: 'cancelled' as const }]) {
    test(`invalid saved meeting fails without effects: ${JSON.stringify(changes)}`, async (t) => {
        const s = await setup(t, changes);
        await assert.rejects(prepareCalendarInvitation(s.task, s.dependencies));
        assert.equal(await s.db.agentProtocolEffects.count(), 0);
    });
}
test('all-day meeting needs no time or duration', async (t) => {
    const s = await setup(t, { isAllDay: true, startTime: undefined, duration: undefined });
    await prepareCalendarInvitation(s.task, s.dependencies);
    assert.equal(s.links.length, 1);
});

for (const status of [503, 400]) {
    test(`unsuccessful effect (${status}) never exposes link`, async (t) => {
        const s = await setup(t);
        s.setExecute(async () => { throw { status }; });
        await assert.rejects(prepareCalendarInvitation(s.task, s.dependencies));
        assert.equal(s.links.length, 0);
    });
}
test('a pending predecessor blocks preparation', async (t) => {
    const s = await setup(t);
    const queued = await s.mutations.queueEffects({ localId: s.task.id, context: newTaskMutationContext('ui', undefined, ACCOUNT),
        effects: [{ kind: 'calendar', operation: 'upsert' }] });
    assert.equal(queued.status, 'queued');
    if (queued.status !== 'queued') throw new Error('queue failed');
    await s.db.agentProtocolEffects.update(queued.effectIds[0], { state: 'retry_scheduled', nextAttemptAt: Date.now() + 60_000 });
    await assert.rejects(prepareCalendarInvitation(s.task, s.dependencies));
    assert.equal(s.links.length, 0);
});
test('a failed predecessor permits a corrected successful upsert of the current meeting', async (t) => {
    const s = await setup(t);
    const queued = await s.mutations.queueEffects({ localId: s.task.id, context: newTaskMutationContext('ui', undefined, ACCOUNT),
        effects: [{ kind: 'calendar', operation: 'upsert' }] });
    if (queued.status !== 'queued') throw new Error('queue failed');
    await s.db.agentProtocolEffects.update(queued.effectIds[0], { state: 'failed' });
    await prepareCalendarInvitation(s.task, s.dependencies);
    assert.equal(s.links.length, 1);
    assert.equal(s.calls.length, 1);
    assert.equal((await s.db.agentProtocolEffects.get(queued.effectIds[0]))?.state, 'failed');
});
test('unavailable auth does not reserve or queue a Calendar event', async (t) => {
    const s = await setup(t);
    await assert.rejects(prepareCalendarInvitation(s.task, { ...s.dependencies, canExecute: () => false }));
    assert.equal(await s.db.agentProtocolEffects.count(), 0);
    assert.equal((await s.db.tasks.get(s.task.id!))?.reservedGoogleEventId, undefined);
});
test('stale draft and wrong account fail before creating effects', async (t) => {
    const s = await setup(t, { googleEventId: 'existing', googleAccountId: ACCOUNT });
    s.switchAccount();
    await assert.rejects(prepareCalendarInvitation(s.task, s.dependencies));
    assert.equal(await s.db.agentProtocolEffects.count(), 0);
    const fresh = await setup(t);
    await fresh.mutations.updateTask({ localId: fresh.task.id, changes: { title: 'Changed' }, context: newTaskMutationContext('ui') });
    await assert.rejects(prepareCalendarInvitation(fresh.task, fresh.dependencies));
    assert.equal(await fresh.db.agentProtocolEffects.count(), 0);
});
test('account or revision changes while reading link invalidate result', async (t) => {
    for (const change of ['account', 'revision']) {
        const s = await setup(t);
        s.dependencies.getLink = async () => {
            if (change === 'account') s.switchAccount();
            else await s.mutations.updateTask({ localId: s.task.id, changes: { title: 'Changed' }, context: newTaskMutationContext('ui') });
            return 'https://calendar.google.com/calendar/event?eid=existing';
        };
        await assert.rejects(prepareCalendarInvitation(s.task, s.dependencies));
    }
});

test('revision changing during delivery prevents the link read', async (t) => {
    const s = await setup(t);
    s.setExecute(async (effect) => {
        await s.mutations.updateTask({ localId: s.task.id, changes: { title: 'Changed during delivery' }, context: newTaskMutationContext('ui') });
        return { externalId: effect.kind === 'calendar' && effect.operation === 'upsert' ? effect.payload.reservedEventId : undefined };
    });
    await assert.rejects(prepareCalendarInvitation(s.task, s.dependencies));
    assert.equal(s.links.length, 0);
});

test('legacy timestamp detects stale saved state without a revision', async (t) => {
    const s = await setup(t);
    await s.db.tasks.update(s.task.id!, { protocolRevision: undefined });
    const legacy = (await s.db.tasks.get(s.task.id!))!;
    await s.db.tasks.update(s.task.id!, { updatedAt: legacy.updatedAt + 1 });
    await assert.rejects(prepareCalendarInvitation(legacy, s.dependencies));
    assert.equal(await s.db.agentProtocolEffects.count(), 0);
    await prepareCalendarInvitation((await s.db.tasks.get(s.task.id!))!, s.dependencies);
    assert.equal(s.links.length, 1);
});

test('finite preparation deadline returns pending and prevents a late link read', async (t) => {
    const s = await setup(t);
    let finish!: () => void;
    s.dependencies.drain = () => new Promise((resolve) => { finish = () => resolve({ attempted: 0, succeeded: 0, retryScheduled: 0, failed: 0 }); });
    await assert.rejects(prepareCalendarInvitation(s.task, { ...s.dependencies, timeoutMs: 5 }), /ještě není dokončená/);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(s.links.length, 0);
});
