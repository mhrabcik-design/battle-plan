/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BattlePlanDB, type Task } from '../db.ts';
import { calendarProjectionToTaskSchedule, toCalendarProjection } from './calendarMapping.ts';
import { GoogleCalendarSync, type CalendarSyncClient, type CalendarSyncSession } from './googleCalendarSync.ts';
import { calendarEffectDeliveryAllowed } from './calendarDeliveryGate.ts';
import { CALENDAR_ACTIVE_ACCOUNT_SETTING, readCalendarSyncSettings, writeCalendarSyncSettings } from './calendarSettings.ts';
import { calendarPrivateIdentity } from './calendarReconciliation.ts';
import { ExternalEffectOutbox, summarizeExternalEffects } from './externalEffectOutbox.ts';
import { executeGoogleExternalEffect } from './externalEffectOutbox.ts';
import { TaskMutationService } from './taskMutations.ts';
import type { CalendarPublicProjection, GoogleCalendarEvent } from './calendarModel.ts';

test('display timezone projects New York event into Prague and preserves exact timing on title edit', () => {
    const projection = { title: 'Call', description: '', timing: { kind: 'timed' as const,
        start: '2026-10-09T09:00:00-04:00', end: '2026-10-09T10:00:00-04:00', timeZone: 'America/New_York' } };
    const schedule = calendarProjectionToTaskSchedule(projection, 'meeting', 'Europe/Prague');
    assert.equal(schedule?.startTime, '15:00');
    const task = { ...schedule, title: 'Changed', type: 'meeting' as const, urgency: 2 as const,
        status: 'pending' as const, createdAt: 1, updatedAt: 1, calendar: { accountId: 'a', calendarId: 'primary', eventId: 'e',
            canonicalIdentity: 'public:p', origin: 'google' as const, generation: 0, metadataUpdatedAt: 1,
            timing: projection.timing, displayTimeZone: 'Europe/Prague' } };
    assert.deepEqual(toCalendarProjection(task)?.timing, projection.timing);
    const changed = toCalendarProjection({ ...task, startTime: '16:00' });
    assert.equal(changed?.timing.kind, 'timed');
    if (changed?.timing.kind === 'timed') assert.equal(Date.parse(changed.timing.start), Date.parse('2026-10-09T14:00:00Z'));
});

test('calendar sync service enables with one action and imports atomically in foreground', async (t) => {
    const { GoogleCalendarSync } = await import('./googleCalendarSync.ts');
    const db = new BattlePlanDB(`calendar-sync-${crypto.randomUUID()}`);
    await db.open();
    t.after(async () => { db.close(); await db.delete(); });
    const client = { listCalendarEvents: async () => ({ events: [{ id: 'e', summary: 'Call',
        start: { date: '2026-10-09' }, end: { date: '2026-10-10' }, organizer: { self: true } }] }),
        getCalendarEvent: async () => null };
    const service = new GoogleCalendarSync(db, client, { now: () => Date.parse('2026-10-09T12:00:00Z'), drain: async () => {} });
    await service.setSession({ accountId: 'a', authKey: 'session', usableAuth: true, online: true, visible: true });
    assert.equal(await db.tasks.count(), 0);
    await service.activate('Europe/Prague');
    await service.refresh();
    assert.equal((await db.tasks.toArray())[0]?.title, 'Call');
    assert.equal(await db.agentProtocolEffects.count(), 0);
});

const NOW = Date.parse('2026-10-09T12:00:00Z');
const SESSION: CalendarSyncSession = { accountId: 'a', authKey: 'session', usableAuth: true, online: true, visible: true };
const SETTINGS = { accountId: 'a', calendarId: 'primary', enabled: true, timeZone: 'Europe/Prague', enrolledPublicIds: [] };
const authored = () => ({ actor: 'battleplan-user', origin: 'ui' as const, causeId: crypto.randomUUID() });
const projection = (title = 'Original', description = 'Original description'): CalendarPublicProjection => ({ title, description,
    timing: { kind: 'timed', start: '2026-10-09T12:00:00Z', end: '2026-10-09T13:00:00Z', timeZone: 'Europe/Prague' } });
function event(id = 'event', title = 'Original', description = 'Original description'): GoogleCalendarEvent {
    return { id, etag: 'etag-1', summary: title, description, organizer: { self: true },
        start: { dateTime: '2026-10-09T12:00:00Z', timeZone: 'Europe/Prague' },
        end: { dateTime: '2026-10-09T13:00:00Z', timeZone: 'Europe/Prague' } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: import('node:test').TestContext, enabled = true) {
    const db = new BattlePlanDB(`calendar-sync-${crypto.randomUUID()}`);
    await db.open(); t.after(async () => { db.close(); await db.delete(); });
    if (enabled) await writeCalendarSyncSettings(db, SETTINGS);
    const f = { db, events: [] as GoogleCalendarEvent[], tracked: new Map<string, GoogleCalendarEvent | null>(),
        lists: 0, gets: [] as string[], drains: 0, now: NOW,
        list: undefined as undefined | (() => Promise<{ events: GoogleCalendarEvent[] }>),
        windows: [] as { timeMin: string; timeMax: string }[],
        get: undefined as undefined | ((id: string) => Promise<GoogleCalendarEvent | null>),
        drain: undefined as undefined | (() => Promise<unknown>), session: { ...SESSION } };
    const client: CalendarSyncClient = {
        listCalendarEvents: async (options, guard) => {
            assert.equal(options.timeZone, 'Europe/Prague'); assert.ok(await guard?.isCurrent()); f.lists++;
            f.windows.push({ timeMin: options.timeMin, timeMax: options.timeMax });
            return f.list ? f.list() : { events: structuredClone(f.events) };
        },
        getCalendarEvent: async (id, _scope, guard) => { assert.ok(await guard?.isCurrent()); f.gets.push(id);
            return f.get ? f.get(id) : structuredClone(f.tracked.get(id) ?? null); },
    };
    const service = new GoogleCalendarSync(db, client, { now: () => f.now,
        drain: async () => { f.drains++; await f.drain?.(); },
        isSessionCurrent: session => session.accountId === f.session.accountId && session.authKey === f.session.authKey });
    await service.setSession(f.session);
    return { ...f, service, client, f, mutations: new TaskMutationService(db, { now: () => f.now }) };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Task> = {}): Promise<Task> {
    const base = projection();
    const task: Task = { publicId: 'task_local', title: base.title, description: base.description, type: 'task', urgency: 3,
        status: 'completed', createdAt: 1, updatedAt: 1, date: '2026-10-09', deadline: '2026-10-09', startTime: '15:00', duration: 60,
        internalNotes: 'Private', subTasks: [{ id: 'check', title: 'Keep me', completed: true }], progress: 42,
        googleAccountId: 'a', googleEventId: 'event', reservedGoogleEventId: 'event',
        calendar: { accountId: 'a', calendarId: 'primary', eventId: 'event', canonicalIdentity: 'public:task_local',
            generation: 0, origin: 'local', metadataUpdatedAt: 1, displayTimeZone: 'Europe/Prague', baseline: base, timing: base.timing, etag: 'etag-1' },
        ...overrides };
    const result = await f.mutations.importTask({ task, context: { actor: 'battleplan-google', origin: 'google', causeId: crypto.randomUUID() } });
    assert.equal(result.status, 'applied'); return result.task;
}

test('complete read includes tracked events outside window; failed tracked GET applies no partial list', async t => {
    const f = await fixture(t); const task = await seed(f);
    f.f.events = [event('new', 'New')];
    f.f.get = async () => { throw new Error('unavailable'); };
    await assert.rejects(f.service.refresh());
    assert.equal(await f.db.tasks.count(), 1);
    assert.equal((await f.db.tasks.get(task.id!))?.calendar?.metadataUpdatedAt, 1);
    assert.equal((await readCalendarSyncSettings(f.db, 'a'))?.lastCheckedAt, undefined);
    assert.equal(f.f.drains, 0);
    f.f.get = undefined;
    f.f.tracked.set('event', { ...event(), start: { dateTime: '2027-09-09T14:00:00Z', timeZone: 'Europe/Prague' },
        end: { dateTime: '2027-09-09T15:00:00Z', timeZone: 'Europe/Prague' }, etag: 'moved' });
    await f.service.refresh();
    const saved = await f.db.tasks.get(task.id!);
    assert.equal(saved?.deadline, '2027-09-09'); assert.equal(saved?.startTime, '17:00');
    assert.equal(await f.db.tasks.count(), 2); assert.deepEqual(f.f.gets, ['event', 'event']);
    assert.equal(await f.db.agentProtocolEffects.count(), 0);
});

test('Google title and local description merge without echo; repeated pull leaves all clocks and revision unchanged', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { description: 'Local description' }, context: authored() });
    f.f.events = [event('event', 'Google title')];
    await f.service.refresh();
    const saved = await f.db.tasks.get(task.id!);
    assert.equal(saved?.title, 'Google title'); assert.equal(saved?.description, 'Local description');
    assert.equal(saved?.internalNotes, 'Private'); assert.equal(saved?.status, 'completed'); assert.equal(saved?.urgency, 3);
    assert.deepEqual(saved?.subTasks, task.subTasks); assert.equal(saved?.progress, 42);
    const count = await f.db.agentProtocolEvents.count(); assert.equal(await f.db.agentProtocolEffects.count(), 1);
    f.f.now += 1000; await f.service.refresh();
    assert.deepEqual(await f.db.tasks.get(task.id!), saved); assert.equal(await f.db.agentProtocolEvents.count(), count);
    assert.equal(await f.db.agentProtocolEffects.count(), 1);
});

test('same-field and ack-successor conflicts stay blocked after repeated observation and baseline advance', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'B' }, context: authored() });
    f.f.events = [event('event', 'C')]; await f.service.refresh();
    const conflicted = (await f.db.tasks.get(task.id!))!;
    assert.deepEqual(conflicted.calendar?.conflict?.fields, ['title']); assert.equal(conflicted.title, 'B');
    // U2 ack has already advanced its common baseline while retaining the B/C conflict.
    await f.db.tasks.put({ ...conflicted, calendar: { ...conflicted.calendar!, baseline: projection('C'), metadataUpdatedAt: NOW + 1 } });
    f.f.now += 1000; await f.service.refresh();
    const saved = await f.db.tasks.get(task.id!);
    assert.equal(saved?.calendar?.conflict?.local?.title, 'B'); assert.equal(saved?.calendar?.conflict?.remote?.title, 'C');
    assert.equal(saved?.title, 'B'); assert.ok(saved?.calendar?.conflict);
});

test('absence in list is not deletion; explicit missing or cancelled suppresses tasks and archives meetings', async t => {
    const f = await fixture(t); const task = await seed(f);
    f.f.tracked.set('event', event()); await f.service.refresh();
    assert.equal((await f.db.tasks.get(task.id!))?.calendar?.suppressed, undefined);
    f.f.tracked.set('event', null); await f.service.refresh();
    const suppressed = (await f.db.tasks.get(task.id!))!;
    assert.equal(suppressed.calendar?.suppressed, true); assert.equal(suppressed.isDeleted, undefined); assert.equal(suppressed.status, 'completed');
    await f.service.refresh(); assert.equal(await f.db.agentProtocolEffects.count(), 0);
    await f.service.restoreTaskBlock(task.publicId!);
    const restored = (await f.db.tasks.get(task.id!))!;
    assert.equal(restored.calendar?.generation, 1); assert.notEqual(restored.calendar?.eventId, 'event');
    assert.equal(restored.googleEventId, undefined); assert.equal(restored.calendar?.suppressed, false);
    assert.equal(await f.db.agentProtocolEffects.count(), 1);
    const meeting = await seed(f, { publicId: 'task_meeting', type: 'meeting', startTime: '14:00', googleEventId: 'meeting',
        reservedGoogleEventId: 'meeting', calendar: { ...task.calendar!, eventId: 'meeting', canonicalIdentity: 'public:task_meeting' } });
    f.f.events = [{ id: 'meeting', status: 'cancelled' }]; await f.service.refresh();
    assert.equal((await f.db.tasks.get(meeting.id!))?.isDeleted, true);
});

test('remote cancellation against pending local intent records a conflict and never recreates automatically', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Local change' }, context: authored() });
    f.f.events = [{ id: 'event', status: 'cancelled' }]; await f.service.refresh();
    const saved = await f.db.tasks.get(task.id!);
    assert.equal(saved?.calendar?.conflict?.kind, 'remote-deleted'); assert.equal(saved?.calendar?.suppressed, true);
    assert.equal(saved?.title, 'Local change'); await assert.rejects(f.service.restoreTaskBlock(task.publicId!));
});

test('legacy first baseline mismatch conflicts, while local tombstones never resurrect from active Google results', async t => {
    const f = await fixture(t); const original = await seed(f);
    await f.db.tasks.put({ ...original, calendar: undefined });
    f.f.events = [event('event', 'Google legacy')]; await f.service.refresh();
    assert.equal((await f.db.tasks.get(original.id!))?.calendar?.conflict?.kind, 'legacy-baseline');
    const tombstone = await seed(f, { publicId: 'task_deleted', isDeleted: true, googleEventId: 'deleted', reservedGoogleEventId: 'deleted',
        calendar: { ...original.calendar!, eventId: 'deleted', canonicalIdentity: 'public:task_deleted' } });
    f.f.events.push(event('deleted', 'Remote edit')); await f.service.refresh();
    const saved = await f.db.tasks.get(tombstone.id!);
    assert.equal(saved?.isDeleted, true); assert.equal(saved?.calendar?.conflict?.kind, 'local-deleted');
    assert.equal(saved?.title, 'Original');
});

test('empty Google title is actual shared data and not a fabricated outbound fallback', async t => {
    const f = await fixture(t); f.f.events = [{ ...event('empty'), summary: undefined }]; await f.service.refresh();
    const task = (await f.db.tasks.toArray())[0]; assert.equal(task.title, '');
    assert.equal(task.calendar?.baseline?.title, ''); assert.equal(toCalendarProjection(task)?.title, '');
    assert.equal(await f.db.agentProtocolEffects.count(), 0);
});

test('recurring, multiday, foreign and unsupported events are one readonly Task each; inherited master identity does not pair instances', async t => {
    const f = await fixture(t); const original = await seed(f);
    const privateFields = calendarPrivateIdentity({ accountId: 'a', calendarId: 'primary', eventId: 'event',
        canonicalIdentity: 'public:task_local', generation: 0, type: 'task', origin: 'local' });
    f.f.events = [
        { ...event('instance-1'), recurringEventId: 'event', extendedProperties: { private: privateFields } },
        { ...event('instance-2'), recurringEventId: 'event', extendedProperties: { private: privateFields } },
        { ...event('multi'), start: { date: '2026-10-09' }, end: { date: '2026-10-12' } },
        { ...event('foreign'), organizer: { self: false }, htmlLink: 'https://calendar.google.com/calendar/event?eid=foreign' },
        { ...event('unsupported'), eventType: 'outOfOffice' },
    ];
    f.f.tracked.set('event', { ...event(), recurrence: ['RRULE:FREQ=DAILY'], extendedProperties: { private: privateFields } });
    await f.service.refresh(); const tasks = await f.db.tasks.toArray(); assert.equal(tasks.length, 6);
    const master = tasks.find(task => task.id === original.id)!;
    assert.equal(master.type, 'task'); assert.equal(master.isDeleted, undefined); assert.equal(master.calendar?.recurringMaster, true);
    for (const task of tasks) assert.ok(task.calendar?.readonlyReason);
    const instances = tasks.filter(task => task.calendar?.recurringEventId); assert.equal(instances.length, 2);
    assert.equal(new Set(instances.map(task => task.publicId)).size, 2);
    assert.ok(instances.every(task => task.publicId !== master.publicId && task.type === 'meeting'));
    assert.ok(tasks.find(task => task.calendar?.eventId === 'foreign')?.calendar?.htmlLink);
    await assert.rejects(f.mutations.updateTask({ publicId: instances[0].publicId, changes: { title: 'No' }, context: authored() }), /readonly/);
});

test('focus burst, shared service remount and hidden generation collapse I/O and discard late results', async t => {
    const f = await fixture(t); const pending = deferred<{ events: GoogleCalendarEvent[] }>(); const started = deferred<void>();
    f.f.list = async () => { started.resolve(); return pending.promise; };
    const first = f.service.refresh(); await started.promise;
    const second = f.service.refresh();
    const remount = new GoogleCalendarSync(f.db, f.client, { now: () => NOW, drain: async () => { f.f.drains++; } });
    const third = remount.refresh(); assert.equal(f.f.lists, 1); assert.equal(first, second); assert.equal(first, third);
    await f.service.setSession({ ...SESSION, visible: false });
    pending.resolve({ events: [event('late')] }); await first;
    assert.equal(await f.db.tasks.count(), 0); assert.equal(f.f.drains, 0); assert.equal((await f.service.getStatus()).phase, 'hidden');
    f.f.list = undefined; f.f.events = [event('fresh')]; await remount.setSession(SESSION); await remount.refresh();
    assert.equal(f.f.lists, 2); assert.equal(await f.db.tasks.count(), 1);
});

test('verified account replacement updates offline author fallback even without enabled settings; logout preserves it', async t => {
    const f = await fixture(t); const pending = deferred<{ events: GoogleCalendarEvent[] }>(); const started = deferred<void>();
    f.f.list = async () => { started.resolve(); return pending.promise; };
    const pull = f.service.refresh(); await started.promise;
    f.f.session = { ...SESSION, accountId: 'b', authKey: 'session-b' }; await f.service.setSession(f.f.session);
    pending.resolve({ events: [event('account-a-late')] }); await pull;
    assert.equal(await f.db.tasks.count(), 0); assert.equal((await f.db.settings.get(CALENDAR_ACTIVE_ACCOUNT_SETTING))?.value, 'b');
    await f.service.setSession({ ...f.f.session, accountId: null, authKey: null, usableAuth: false, online: false });
    const result = await f.mutations.createTask({ task: { title: 'Offline B', type: 'task', urgency: 2, status: 'pending',
        deadline: '2026-10-09', startTime: '15:00', duration: 60 }, context: authored() });
    assert.equal(result.status, 'applied'); assert.equal(result.effectIds.length, 0);
    assert.equal((await f.db.settings.get(CALENDAR_ACTIVE_ACCOUNT_SETTING))?.value, 'b');
});

test('one activation automatically exports every existing plan after observation, without a date selection or duplicates', async t => {
    const f = await fixture(t, false);
    const first = await f.mutations.createTask({ task: { title: 'Existing task', type: 'task', urgency: 2, status: 'pending',
        deadline: '2025-01-01', startTime: '15:00', duration: 60 }, context: authored() });
    const second = await f.mutations.createTask({ task: { title: 'Existing meeting', type: 'meeting', urgency: 2, status: 'pending',
        date: '2027-09-01', startTime: '09:00', duration: 60 }, context: authored() });
    assert.equal(first.status, 'applied'); assert.equal(second.status, 'applied');
    assert.equal(await f.db.agentProtocolEffects.count(), 0);
    await f.service.activate('Europe/Prague');
    assert.equal((await readCalendarSyncSettings(f.db, 'a'))?.enabled, true);
    assert.equal(await f.db.agentProtocolEffects.count(), 2, 'all existing plans are queued together');
    const worker = new ExternalEffectOutbox(f.db, { accountId: () => 'a',
        canDeliver: effect => calendarEffectDeliveryAllowed(f.db, effect, 'a', 'session'), execute: async () => ({}) });
    assert.equal((await worker.drainOnce()).attempted, 0, 'enabling alone cannot send before observation');
    await f.service.refresh();
    const effects = await f.db.agentProtocolEffects.toArray();
    assert.deepEqual(effects.map(effect => effect.entityPublicId).sort(), [first.task.publicId, second.task.publicId].sort());
    assert.ok(effects.every(effect => effect.kind === 'calendar' && effect.payload.automatic));
    await f.service.activate('Europe/Prague'); await f.service.refresh();
    assert.equal(await f.db.agentProtocolEffects.count(), 2);
});

test('already enabled legacy selection automatically enrolls omitted plans and preserves opt-outs and account boundaries', async t => {
    const f = await fixture(t);
    await writeCalendarSyncSettings(f.db, { ...SETTINGS, enrolledPublicIds: ['task_previously_selected'] });
    const local = { type: 'task' as const, urgency: 2 as const, status: 'pending' as const,
        deadline: '2026-10-09', startTime: '15:00', duration: 60, createdAt: 1, updatedAt: 1 };
    await f.db.tasks.bulkAdd([
        { ...local, publicId: 'task_omitted', title: 'Omitted task' },
        { ...local, publicId: 'task_native', title: 'Native Google Task', googleId: 'native' },
        { ...local, publicId: 'task_foreign', title: 'Other account', googleAccountId: 'b' },
        { ...local, publicId: 'task_deleted', title: 'Archived task', isDeleted: true },
        { ...local, publicId: 'task_unscheduled', title: 'Implicit fallback', calendarScheduleExplicit: false },
    ]);
    await seed(f, { publicId: 'task_cancelled', calendar: { accountId: 'a', calendarId: 'primary', eventId: 'cancelled',
        canonicalIdentity: 'public:task_cancelled', origin: 'local', generation: 0, metadataUpdatedAt: 1, suppressed: true } });
    await f.service.refresh(); await f.service.refresh();
    const effects = await f.db.agentProtocolEffects.toArray();
    assert.deepEqual(effects.map(effect => effect.entityPublicId), ['task_omitted']);
    assert.equal((await f.db.tasks.where('publicId').equals('task_cancelled').first())?.calendar?.suppressed, true);
});

test('automatic enrollment waits for successful observation and pairs an existing remote target outside the read window', async t => {
    const f = await fixture(t);
    const task: Task = { publicId: 'task_recovered', title: 'Recovered local plan', type: 'meeting', urgency: 2,
        status: 'pending', date: '2027-09-01', startTime: '09:00', duration: 60, createdAt: 1, updatedAt: 1 };
    await f.db.tasks.add(task);
    f.f.list = async () => { throw new Error('offline'); };
    await assert.rejects(f.service.refresh());
    assert.equal(await f.db.agentProtocolEffects.count(), 0);
    const { deterministicCalendarEventId } = await import('./calendarMapping.ts');
    const targetId = deterministicCalendarEventId(task, 'a', 'primary', 0);
    f.f.tracked.set(targetId, { ...event(targetId, 'Google plan'),
        extendedProperties: { private: { battleplanAccount: 'a', battleplanCalendar: 'primary',
            battleplanIdentity: 'public:task_recovered', battleplanType: 'meeting', battleplanOrigin: 'local', battleplanGeneration: '0' } } });
    f.f.list = undefined;
    await f.service.refresh();
    assert.ok(f.f.gets.includes(targetId), 'unlinked deterministic targets are observed before enrollment');
    assert.equal(await f.db.agentProtocolEffects.count(), 0, 'a recovered remote pairing is not created again');
    assert.equal((await f.db.tasks.where('publicId').equals('task_recovered').first())?.googleEventId, targetId);
});

test('failed first pull gates all Calendar intents including immediate drains and legacy payloads; disabled pauses automatic only', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Local' }, context: authored() });
    let sends = 0;
    const outbox = new ExternalEffectOutbox(f.db, { accountId: () => 'a',
        canDeliver: effect => calendarEffectDeliveryAllowed(f.db, effect, 'a', 'session'), execute: async () => { sends++; return {}; } });
    f.f.list = async () => { throw new Error('list failed'); };
    await assert.rejects(f.service.refresh()); assert.equal((await outbox.drainOnce()).attempted, 0); assert.equal(sends, 0);
    await f.service.disable(); assert.equal((await outbox.drainOnce()).attempted, 0);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Edit while disabled' }, context: authored(),
        effects: [{ kind: 'calendar', operation: 'upsert' }] });
    assert.equal(await f.db.agentProtocolEffects.count(), 1, 'normal authored edits cannot restart disabled automatic sync');
    const [automatic] = await f.db.agentProtocolEffects.toArray(); assert.ok(automatic.kind === 'calendar' && automatic.operation === 'upsert');
    assert.equal(await calendarEffectDeliveryAllowed(f.db, { ...automatic, payload: { ...automatic.payload, automatic: undefined } }, 'a', 'session'), true);
    assert.equal((await f.service.getStatus()).phase, 'disabled');
});

test('Google conflict choice accepts fresh remote, preserves notes and explicitly supersedes queued local intents', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Local' }, context: authored() });
    f.f.events = [event('event', 'Google')]; await f.service.refresh();
    f.f.tracked.set('event', event('event', 'Latest Google', 'Latest description'));
    assert.equal(await f.service.resolveConflict(task.publicId!, 'google'), 'stale');
    assert.equal(await f.service.resolveConflict(task.publicId!, 'google'), 'resolved');
    const saved = await f.db.tasks.get(task.id!); assert.equal(saved?.title, 'Latest Google'); assert.equal(saved?.internalNotes, 'Private');
    assert.equal(saved?.calendar?.conflict, undefined); assert.equal(saved?.calendar?.baseline?.title, 'Latest Google');
    const effects = await f.db.agentProtocolEffects.toArray(); assert.equal(effects[0].state, 'failed');
    assert.equal(effects[0].lastErrorCode, 'external_effect_failed'); assert.equal(effects[0].superseded, true);
    assert.equal(summarizeExternalEffects(effects, 'a').failed, 0);
    let sends = 0; await new ExternalEffectOutbox(f.db, { accountId: () => 'a', execute: async () => { sends++; return {}; } }).drainOnce();
    assert.equal(sends, 0);
});

test('Battleplan choice rebases fresh remote and sends only a new current intent; stale local change during GET requires new decision', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Local' }, context: authored() });
    f.f.events = [event('event', 'Google')]; await f.service.refresh();
    const response = deferred<GoogleCalendarEvent | null>(); const started = deferred<void>();
    f.f.get = async () => { started.resolve(); return response.promise; };
    const resolve = f.service.resolveConflict(task.publicId!, 'battleplan'); await started.promise;
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Newer Local' }, context: authored() });
    response.resolve(event('event', 'Latest Google', 'Fresh Google description'));
    assert.equal(await resolve, 'stale'); assert.ok((await f.db.tasks.get(task.id!))?.calendar?.conflict);
    f.f.get = undefined; f.f.tracked.set('event', event('event', 'Latest Google', 'Fresh Google description'));
    assert.equal(await f.service.resolveConflict(task.publicId!, 'battleplan'), 'stale');
    assert.equal(await f.service.resolveConflict(task.publicId!, 'battleplan'), 'resolved');
    const saved = await f.db.tasks.get(task.id!); assert.equal(saved?.title, 'Newer Local');
    assert.equal(saved?.description, 'Fresh Google description', 'disjoint remote fields survive the Battleplan title choice');
    assert.equal(saved?.calendar?.baseline?.title, 'Latest Google');
    const active = (await f.db.agentProtocolEffects.toArray()).filter(effect => effect.state === 'pending'); assert.equal(active.length, 1);
    assert.ok(active[0].kind === 'calendar' && active[0].operation === 'upsert');
    assert.equal(active[0].payload.projection?.title, 'Newer Local'); assert.equal(active[0].payload.previousProjection?.title, 'Latest Google');
});

test('a higher portable generation from another device adopts one existing task without resurrecting obsolete IDs', async t => {
    const f = await fixture(t); const old = await seed(f);
    await f.db.tasks.put({ ...old, calendar: { ...old.calendar!, suppressed: true } });
    f.f.events = [{ ...event('new-generation', 'Restored on another device'), extendedProperties: { private: calendarPrivateIdentity({
        accountId: 'a', calendarId: 'primary', eventId: 'new-generation', canonicalIdentity: 'public:task_local',
        generation: 1, type: 'task', origin: 'local' }) } }];
    f.f.tracked.set('event', null);
    await f.service.refresh(); const saved = await f.db.tasks.get(old.id!);
    assert.equal(await f.db.tasks.count(), 1); assert.equal(saved?.calendar?.generation, 1);
    assert.equal(saved?.calendar?.eventId, 'new-generation'); assert.equal(saved?.googleEventId, 'new-generation');
    assert.equal(saved?.calendar?.suppressed, false); assert.equal(saved?.title, 'Restored on another device');
});

test('a changed remote version requires a new conflict decision before accepting either side', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'B' }, context: authored() });
    f.f.events = [event('event', 'C')]; await f.service.refresh();
    f.f.tracked.set('event', { ...event('event', 'D'), etag: 'etag-new' });
    assert.equal(await f.service.resolveConflict(task.publicId!, 'google'), 'stale');
    const changed = await f.db.tasks.get(task.id!);
    assert.equal(changed?.title, 'B'); assert.equal(changed?.calendar?.conflict?.remote?.title, 'D');
    assert.equal(changed?.calendar?.conflict?.remoteEtag, 'etag-new');
    assert.equal((await f.db.agentProtocolEffects.toArray())[0].state, 'pending');
    assert.equal(await f.service.resolveConflict(task.publicId!, 'google'), 'resolved');
    assert.equal((await f.db.tasks.get(task.id!))?.title, 'D');
});

test('a changed configuration before commit cannot authorize delivery without a complete fresh committed pull', async t => {
    const f = await fixture(t);
    await f.db.agentProtocolEffects.put({ id: 'legacy', kind: 'calendar', operation: 'upsert', entityKind: 'task',
        entityPublicId: 'task_legacy', mutationId: crypto.randomUUID(), accountId: 'a', sequence: 1, state: 'pending',
        attempts: 0, fencingToken: 0, createdAt: 1, updatedAt: 1,
        payload: { title: 'Legacy', status: 'pending', reservedEventId: 'legacy-event', googleEventId: 'legacy-event', date: '2026-10-09', startTime: '09:00' } });
    f.f.list = async () => { await writeCalendarSyncSettings(f.db, { ...SETTINGS, timeZone: 'America/New_York' }); return { events: [event('new')] }; };
    await f.service.refresh();
    assert.equal(await f.db.tasks.count(), 0); assert.equal(f.f.drains, 0);
    assert.equal((await readCalendarSyncSettings(f.db, 'a'))?.lastCheckedAt, undefined);
    const effect = (await f.db.agentProtocolEffects.toArray())[0];
    assert.equal(await calendarEffectDeliveryAllowed(f.db, effect, 'a', 'session'), false);
});

test('an old active event generation cannot duplicate or abort the current recreated pairing', async t => {
    const f = await fixture(t); const base = projection();
    const task = await seed(f, { googleEventId: 'new-event', reservedGoogleEventId: 'new-event',
        calendar: { accountId: 'a', calendarId: 'primary', eventId: 'new-event', canonicalIdentity: 'public:task_local',
            origin: 'local', generation: 1, metadataUpdatedAt: 1, baseline: base, timing: base.timing, displayTimeZone: 'Europe/Prague' } });
    f.f.events = [{ ...event('old-event'), extendedProperties: { private: calendarPrivateIdentity({ accountId: 'a', calendarId: 'primary',
        eventId: 'old-event', canonicalIdentity: 'public:task_local', generation: 0, type: 'task', origin: 'local' }) } }, event('other')];
    f.f.tracked.set('new-event', event('new-event')); await f.service.refresh();
    assert.equal(await f.db.tasks.count(), 2); assert.equal((await f.db.tasks.get(task.id!))?.calendar?.eventId, 'new-event');
    assert.equal((await f.db.tasks.get(task.id!))?.calendar?.generation, 1);
});

test('enabled fresh pull modernizes a legacy queued snapshot from current Task without title or description rewind', async t => {
    const f = await fixture(t); const task = await seed(f, { title: 'B' });
    await f.db.agentProtocolEffects.put({ id: 'legacy', kind: 'calendar', operation: 'upsert', entityKind: 'task',
        entityPublicId: task.publicId!, mutationId: crypto.randomUUID(), accountId: 'a', sequence: 1, state: 'pending',
        attempts: 0, fencingToken: 0, createdAt: 1, updatedAt: 1,
        payload: { title: 'A', status: 'pending', description: 'Original description', reservedEventId: 'event', googleEventId: 'event',
            date: '2026-10-09', startTime: '09:00', duration: 60 } });
    let writes = 0;
    const writer = { addToCalendar: async () => { throw new Error('unsafe legacy call'); }, deleteFromCalendar: async () => true as const,
        updateGoogleTask: async () => true, writeCalendarEffect: async (request: import('./calendarReconciliation.ts').CalendarWriteRequest) => {
            writes++; assert.equal(request.projection?.title, 'B'); assert.equal(request.projection?.description, 'Google description');
            assert.deepEqual(request.projection?.timing, projection().timing);
            return { externalId: 'event', calendar: { accountId: 'a', calendarId: 'primary', eventId: 'event',
                canonicalIdentity: 'public:task_local', generation: 0, etag: 'fresh', projection: request.projection,
                sentProjection: request.sentProjection } };
        } };
    const outbox = new ExternalEffectOutbox(f.db, { accountId: () => 'a',
        canDeliver: effect => calendarEffectDeliveryAllowed(f.db, effect, 'a', 'session'),
        execute: (effect, guard) => executeGoogleExternalEffect(writer, effect, guard) });
    assert.equal((await outbox.drainOnce()).attempted, 0);
    f.f.events = [event('event', 'Original', 'Google description')]; f.f.drain = () => outbox.drainOnce();
    await f.service.refresh(); assert.equal(writes, 1);
    const saved = await f.db.tasks.get(task.id!); assert.equal(saved?.title, 'B'); assert.equal(saved?.description, 'Google description');
    assert.equal(saved?.calendar?.baseline?.title, 'B'); assert.equal(saved?.calendar?.baseline?.description, 'Google description');
    assert.equal((await f.db.agentProtocolEffects.toArray())[0].state, 'succeeded');
});

test('re-enabling delivers paired edits made while disabled, merges Google fields and does not echo imports', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.service.disable();
    const changed = await f.mutations.updateTask({ publicId: task.publicId,
        changes: { title: 'Changed while disabled', internalNotes: 'Still private' }, context: authored() });
    assert.equal(changed.status, 'applied'); assert.equal(changed.effectIds.length, 0);
    let writes = 0;
    const writer = { addToCalendar: async () => { throw new Error('unexpected create'); }, deleteFromCalendar: async () => true as const,
        updateGoogleTask: async () => true, writeCalendarEffect: async (request: import('./calendarReconciliation.ts').CalendarWriteRequest) => {
            writes++; assert.equal(request.operation, 'upsert'); assert.equal(request.eventId, 'event');
            assert.equal(request.projection?.title, 'Changed while disabled');
            assert.equal(request.projection?.description, 'Google description');
            f.f.events = [event('event', request.projection!.title, request.projection!.description), event('imported', 'Google-only')];
            return { externalId: 'event', calendar: { accountId: 'a', calendarId: 'primary', eventId: 'event',
                canonicalIdentity: 'public:task_local', generation: 0, etag: 'fresh', projection: request.projection,
                sentProjection: request.sentProjection } };
        } };
    const outbox = new ExternalEffectOutbox(f.db, { accountId: () => 'a',
        canDeliver: effect => calendarEffectDeliveryAllowed(f.db, effect, 'a', 'session'),
        execute: (effect, guard) => executeGoogleExternalEffect(writer, effect, guard) });
    f.f.events = [event('event', 'Original', 'Google description'), event('imported', 'Google-only')];
    f.f.drain = () => outbox.drainOnce();
    await f.service.activate('Europe/Prague');
    assert.equal((await outbox.drainOnce()).attempted, 0, 're-enable still needs a committed pull');
    await f.service.refresh(); assert.equal(writes, 1);
    const saved = (await f.db.tasks.get(task.id!))!;
    assert.equal(saved.title, 'Changed while disabled'); assert.equal(saved.internalNotes, 'Still private');
    assert.deepEqual(saved.subTasks, task.subTasks); assert.equal(saved.calendar?.generation, 0);
    await f.service.refresh(); assert.equal(writes, 1); assert.equal(await f.db.agentProtocolEffects.count(), 1);
    await f.service.disable();
    await f.mutations.updateTask({ publicId: task.publicId, changes: { internalNotes: 'Private edit only' }, context: authored() });
    await f.service.activate('Europe/Prague'); await f.service.refresh();
    assert.equal(writes, 1, 'private-only edits and unchanged Google imports never echo');
});

test('re-enabling queues the latest paired intent after an older pending effect and preserves deletion', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Older pending' }, context: authored() });
    await f.service.disable();
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Latest while disabled' }, context: authored() });
    const deleted = await seed(f, { publicId: 'task_deleted_off', googleEventId: 'deleted', reservedGoogleEventId: 'deleted',
        calendar: { ...task.calendar!, eventId: 'deleted', canonicalIdentity: 'public:task_deleted_off' } });
    await f.mutations.archiveTask({ publicId: deleted.publicId, context: authored() });
    await f.service.activate('Europe/Prague');
    const queued = await f.db.agentProtocolEffects.toArray();
    assert.equal(queued.filter(effect => effect.entityPublicId === task.publicId).length, 2);
    assert.ok(queued.some(effect => effect.entityPublicId === task.publicId && effect.operation === 'upsert'
        && effect.payload.projection?.title === 'Latest while disabled'));
    assert.ok(queued.some(effect => effect.entityPublicId === deleted.publicId && effect.operation === 'delete'));
    let remoteTitle = 'Original', remoteDeleted = false;
    const writer = { addToCalendar: async () => { throw new Error('unexpected create'); }, deleteFromCalendar: async () => true as const,
        updateGoogleTask: async () => true, writeCalendarEffect: async (request: import('./calendarReconciliation.ts').CalendarWriteRequest) => {
            if (request.operation === 'delete') remoteDeleted = true;
            else remoteTitle = request.projection!.title;
            f.f.events = [event('event', remoteTitle), remoteDeleted ? { id: 'deleted', status: 'cancelled' } : event('deleted')];
            return { externalId: request.eventId, calendar: { accountId: 'a', calendarId: 'primary', eventId: request.eventId,
                canonicalIdentity: request.canonicalIdentity, generation: request.generation,
                ...(request.operation === 'delete' ? { deleted: true } : { projection: request.projection, sentProjection: request.sentProjection }) } };
        } };
    const outbox = new ExternalEffectOutbox(f.db, { accountId: () => 'a',
        canDeliver: effect => calendarEffectDeliveryAllowed(f.db, effect, 'a', 'session'),
        execute: (effect, guard) => executeGoogleExternalEffect(writer, effect, guard) });
    f.f.drain = () => outbox.drainOnce();
    f.f.events = [event(), event('deleted')];
    await f.service.refresh(); await f.service.refresh();
    assert.equal(remoteTitle, 'Latest while disabled'); assert.equal(remoteDeleted, true);
    assert.ok((await f.db.agentProtocolEffects.toArray()).every(effect => effect.state === 'succeeded'));
    assert.equal(await f.db.agentProtocolEffects.count(), 3, 'refresh does not append duplicate paired intents');
    assert.equal((await f.db.tasks.get(deleted.id!))?.isDeleted, true);
});

test('activation rolls back settings and all enrollment when a later effect cannot be queued', async t => {
    const f = await fixture(t, false);
    for (const title of ['First', 'Second']) await f.mutations.createTask({ task: { title, type: 'meeting', urgency: 2,
        status: 'pending', date: '2026-10-09', startTime: '14:00', duration: 60 }, context: authored() });
    let creates = 0;
    const failSecond = () => { if (++creates === 2) throw new Error('injected second effect failure'); };
    f.db.agentProtocolEffects.hook('creating', failSecond);
    try { await assert.rejects(f.service.activate('Europe/Prague'), /injected second effect failure/); }
    finally { f.db.agentProtocolEffects.hook('creating').unsubscribe(failSecond); }
    assert.equal(await readCalendarSyncSettings(f.db, 'a'), undefined);
    assert.equal(await f.db.agentProtocolEffects.count(), 0);
    assert.ok((await f.db.tasks.toArray()).every(task => !task.calendar && !task.reservedGoogleEventId));
    await f.service.activate('Europe/Prague'); assert.equal(await f.db.agentProtocolEffects.count(), 2);
});

test('live read window rolls with today after activation', async t => {
    const f = await fixture(t, false);
    await f.service.activate('Europe/Prague');
    await f.service.refresh(); f.f.now += 200 * 86_400_000; await f.service.refresh();
    assert.notEqual(f.f.windows[0].timeMin, f.f.windows[1].timeMin);
    assert.equal(Math.round((Date.parse(f.f.windows[1].timeMin) - Date.parse(f.f.windows[0].timeMin)) / 86_400_000), 200);
});

test('explicit tombstone choices either retain conditional deletion or accept Google without losing private data', async t => {
    const f = await fixture(t); const task = await seed(f, { isDeleted: true });
    f.f.events = [event('event', 'Remote changed')]; await f.service.refresh();
    f.f.tracked.set('event', event('event', 'Remote changed'));
    const events = await f.db.agentProtocolEvents.count();
    assert.equal(await f.service.resolveConflict(task.publicId!, 'battleplan'), 'resolved');
    const saved = (await f.db.tasks.get(task.id!))!;
    assert.equal(saved.isDeleted, true); assert.equal(saved.calendar?.conflict, undefined);
    assert.equal(await f.db.agentProtocolEvents.count(), events, 'no temporary resurrection event is published');
    const [effect] = await f.db.agentProtocolEffects.toArray(); assert.ok(effect.kind === 'calendar' && effect.operation === 'delete');
    assert.equal(effect.payload.baseline?.title, 'Remote changed');
    f.f.events = [event('event', 'Changed again')]; await f.service.refresh(); f.f.tracked.set('event', event('event', 'Changed again'));
    assert.equal(await f.service.resolveConflict(task.publicId!, 'google'), 'resolved');
    const restored = await f.db.tasks.get(task.id!); assert.equal(restored?.isDeleted, false);
    assert.equal(restored?.title, 'Changed again'); assert.equal(restored?.internalNotes, 'Private');
});

test('explicit Battleplan resolution of a remotely deleted meeting allocates a new generation', async t => {
    const f = await fixture(t); const task = await seed(f, { type: 'meeting', startTime: '14:00' });
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'Local meeting' }, context: authored() });
    f.f.events = [{ id: 'event', status: 'cancelled' }]; await f.service.refresh();
    f.f.tracked.set('event', { id: 'event', status: 'cancelled' });
    assert.equal(await f.service.resolveConflict(task.publicId!, 'battleplan'), 'resolved');
    const saved = await f.db.tasks.get(task.id!); assert.equal(saved?.calendar?.generation, 1);
    assert.notEqual(saved?.calendar?.eventId, 'event'); assert.equal(Boolean(saved?.isDeleted), false);
    assert.equal(saved?.title, 'Local meeting'); assert.equal(saved?.calendar?.conflict, undefined);
});

test('a dialog version cannot accept a conflict already changed by an observer before the click', async t => {
    const f = await fixture(t); const task = await seed(f);
    await f.mutations.updateTask({ publicId: task.publicId, changes: { title: 'B' }, context: authored() });
    f.f.events = [event('event', 'C')]; await f.service.refresh();
    const viewed = (await f.db.tasks.get(task.id!))!;
    const expected = { revisionId: viewed.protocolRevision?.revision_id ?? null, metadataUpdatedAt: viewed.calendar!.metadataUpdatedAt };
    f.f.events = [event('event', 'D')]; await f.service.refresh();
    assert.equal(await f.service.resolveConflict(task.publicId!, 'google', expected), 'stale');
    assert.equal(f.f.gets.length, 0); assert.equal((await f.db.tasks.get(task.id!))?.title, 'B');
    assert.equal((await f.db.tasks.get(task.id!))?.calendar?.conflict?.remote?.title, 'D');
});

test('an organizer without an affirmative self flag remains read only', async t => {
    const f = await fixture(t); f.f.events = [{ ...event('foreign-default'), organizer: { email: 'other@example.test' } }];
    await f.service.refresh(); const [task] = await f.db.tasks.toArray();
    assert.equal(task.calendar?.readonlyReason, 'foreign-organizer');
});

test('offline or unavailable auth exposes status and cannot perform new reads or import private native Tasks', async t => {
    const f = await fixture(t);
    await f.service.setSession({ ...SESSION, online: false }); await f.service.refresh();
    assert.equal((await f.service.getStatus()).phase, 'offline'); assert.equal(f.f.lists, 0);
    await f.service.setSession({ ...SESSION, accountId: null, authKey: null, usableAuth: false }); await f.service.refresh();
    assert.equal((await f.service.getStatus()).phase, 'auth-required'); assert.equal(f.f.lists, 0);
    await assert.rejects(f.service.activate());
    await f.service.setSession(SESSION); await f.service.refresh(); assert.equal(f.f.lists, 1);
});
