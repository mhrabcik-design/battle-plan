import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattlePlanDB } from '../db.ts';
import { ExternalEffectOutbox, summarizeExternalEffects } from '../services/externalEffectOutbox.ts';
import { TaskMutationService, newTaskMutationContext } from '../services/taskMutations.ts';
import type { CalendarSyncStatus } from '../services/googleCalendarSync.ts';
import { getCalendarSyncIndicator } from './calendarSyncIndicator.ts';

const accountId = 'owner@example.com';
const status = (patch: Partial<CalendarSyncStatus> = {}): CalendarSyncStatus => ({
    enabled: true, accountId, phase: 'ready', lastCheckedAt: 1, pending: 0, conflicts: [], error: null, timeZone: 'UTC', ...patch,
});
const base = () => ({ status: status(), effects: summarizeExternalEffects([], accountId), accountId, isOnline: true, authenticated: true });

test('an empty queue is green only after an enabled Calendar was checked for the current usable account', () => {
    assert.equal(getCalendarSyncIndicator(base()).state, 'synced');
    for (const patch of [
        { status: undefined }, { effects: undefined }, { status: status({ enabled: false, phase: 'disabled' }) },
        { status: status({ lastCheckedAt: null }) }, { isOnline: false }, { authenticated: false },
        { status: status({ phase: 'auth-required' }) }, { status: status({ phase: 'hidden' }) }, { accountId: 'other@example.com' },
    ]) assert.notEqual(getCalendarSyncIndicator({ ...base(), ...patch }).state, 'synced', JSON.stringify(patch));
    assert.equal(getCalendarSyncIndicator({ ...base(), status: status({ phase: 'checking' }) }).state, 'syncing');
});

test('checking the Calendar never makes queued local changes look synchronized', () => {
    const args = { ...base(), effects: { ...base().effects, pending: 2 } };
    assert.equal(getCalendarSyncIndicator(args).state, 'pending');
    assert.equal(getCalendarSyncIndicator({ ...args, status: status({ phase: 'checking' }) }).state, 'syncing');
    assert.equal(getCalendarSyncIndicator({ ...args, isOnline: false }).state, 'pending');
    assert.equal(getCalendarSyncIndicator({ ...args, authenticated: false }).state, 'pending');
    assert.equal(getCalendarSyncIndicator({ ...args, status: status({ enabled: false, phase: 'disabled' }) }).pending, 2);
    const blocked = getCalendarSyncIndicator({ ...args, effects: { ...args.effects, accountBlocked: 2, running: 1 } });
    assert.equal(blocked.state, 'pending');
    assert.match(blocked.detail, /správnému Google účtu/);
});

test('conflicts and failed writes remain visible even when the active queue is empty', () => {
    assert.equal(getCalendarSyncIndicator({ ...base(), effects: { ...base().effects, failed: 1 } }).state, 'error');
    assert.equal(getCalendarSyncIndicator({ ...base(), status: status({ phase: 'error', error: 'Kontrola selhala' }) }).detail, 'Kontrola selhala');
    const conflict = { title: 'Spor' } as CalendarSyncStatus['conflicts'][number];
    assert.equal(getCalendarSyncIndicator({ ...base(), status: status({ conflicts: [conflict] }) }).label, 'Vyřešit konflikt');
    assert.equal(getCalendarSyncIndicator({ ...base(), accountId: 'new@example.com', status: status({ conflicts: [conflict] }) }).state, 'neutral');
});

test('the real durable outbox changes the indicator from waiting through delivery to acknowledged success', async t => {
    const db = new BattlePlanDB(`CalendarIndicator-${crypto.randomUUID()}`);
    await db.open();
    t.after(() => db.delete());
    const mutations = new TaskMutationService(db);
    const created = await mutations.createTask({
        task: { title: 'Schůzka', type: 'meeting', status: 'pending', urgency: 2, date: '2026-10-10' },
        context: newTaskMutationContext('ui', undefined, accountId), effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    assert.equal(created.status, 'applied');
    const indicator = async () => getCalendarSyncIndicator({ ...base(), effects: summarizeExternalEffects(await db.agentProtocolEffects.toArray(), accountId) });
    assert.equal((await indicator()).state, 'pending');
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const worker = new ExternalEffectOutbox(db, { accountId: () => accountId, execute: async effect => {
        started(); await pending;
        return { externalId: effect.kind === 'calendar' && effect.operation === 'upsert' ? effect.payload.reservedEventId : undefined };
    } });
    const delivery = worker.drainOnce();
    await entered;
    assert.equal((await indicator()).state, 'syncing');
    release();
    assert.equal((await delivery).succeeded, 1);
    assert.equal((await indicator()).state, 'synced');
    assert.equal((await indicator()).pending, 0);
});

test('a rejected write stays red until a corrected successor is acknowledged; other accounts never count as delivered', async t => {
    const db = new BattlePlanDB(`CalendarIndicatorFailure-${crypto.randomUUID()}`);
    await db.open();
    t.after(() => db.delete());
    const mutations = new TaskMutationService(db);
    const created = await mutations.createTask({
        task: { title: 'Schůzka', type: 'meeting', status: 'pending', urgency: 2, date: '2026-10-10' },
        context: newTaskMutationContext('ui', undefined, accountId), effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    if (created.status !== 'applied') throw new Error('Create failed');
    const firstId = created.effectIds[0];
    const worker = new ExternalEffectOutbox(db, { accountId: () => accountId, execute: async effect => {
        if (effect.id === firstId) throw { status: 400 };
        return { externalId: effect.kind === 'calendar' && effect.operation === 'upsert' ? effect.payload.reservedEventId : undefined };
    } });
    const indicator = async () => getCalendarSyncIndicator({ ...base(), effects: summarizeExternalEffects(await db.agentProtocolEffects.toArray(), accountId) });
    assert.equal((await worker.drainOnce()).failed, 1);
    assert.equal((await indicator()).state, 'error');
    await mutations.updateTask({ localId: created.task.id, changes: { title: 'Opravená schůzka' },
        context: newTaskMutationContext('ui', undefined, accountId), effects: [{ kind: 'calendar', operation: 'upsert' }] });
    assert.equal((await indicator()).state, 'error');
    assert.equal((await worker.drainOnce()).succeeded, 1);
    assert.equal((await indicator()).state, 'synced');
    await mutations.updateTask({ localId: created.task.id, changes: { title: 'Další změna' },
        context: newTaskMutationContext('ui', undefined, accountId), effects: [{ kind: 'calendar', operation: 'upsert' }] });
    const other = 'other@example.com';
    assert.equal(getCalendarSyncIndicator({ ...base(), accountId: other, status: status({ accountId: other }),
        effects: summarizeExternalEffects(await db.agentProtocolEffects.toArray(), other) }).state, 'pending');
});
