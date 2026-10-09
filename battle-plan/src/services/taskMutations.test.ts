/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BattlePlanDB, type Task } from '../db.ts';
import { AgentProtocolLedger } from './agentProtocol/ledger.ts';
import { applyTaskEffectMetadata, calendarEffectsForLocalTask, taskMutationTables, TaskMutationService } from './taskMutations.ts';
import { writeCalendarSyncSettings, isCalendarHistoryEnrolled } from './calendarSettings.ts';
import { ensureTaskDeadline } from './taskNormalization.ts';

const settings = { accountId: 'account-a', calendarId: 'primary', enabled: true, timeZone: 'Europe/Prague', enrolledPublicIds: [] };
const authored = { actor: 'battleplan-user', origin: 'ui' as const, causeId: '018f6f5e-2d88-7f2a-8f90-d6ad23001001' };

const CAUSES = {
    ui: '018f6f5e-2d88-7f2a-8f90-d6ad23001001',
    voice: '018f6f5e-2d88-7f2a-8f90-d6ad23001002',
    hermes: '018f6f5e-2d88-7f2a-8f90-d6ad23001003',
    drive: '018f6f5e-2d88-7f2a-8f90-d6ad23001004',
} as const;

test('enabled offline account automatically exports the authored task end interval and portable identity', async (t) => {
    const db = await database(t);
    await db.settings.bulkPut([
        { id: 'calendar-sync-active-account', value: 'account-a' },
        { id: 'calendar-sync:account-a', value: JSON.stringify({ accountId: 'account-a', calendarId: 'primary', enabled: true, timeZone: 'Europe/Prague', enrolledPublicIds: [] }) },
    ]);
    const result = await new TaskMutationService(db).createTask({
        task: { ...task(), publicId: 'task_portable', date: '2026-10-01', deadline: '2026-10-09', startTime: '15:00', duration: 60 },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(result.status, 'applied');
    const effects = await db.agentProtocolEffects.toArray();
    assert.equal(effects.length, 1);
    assert.ok(effects[0].kind === 'calendar' && effects[0].operation === 'upsert');
    assert.equal(effects[0].accountId, 'account-a');
    assert.equal(effects[0].payload.type, 'task');
    assert.equal(effects[0].payload.publicId, 'task_portable');
    assert.equal(effects[0].payload.canonicalIdentity, 'public:task_portable');
    assert.deepEqual(effects[0].payload.projection, {
        title: 'Atomic task', description: 'Visible detail',
        timing: { kind: 'timed', start: '2026-10-09T12:00:00.000Z', end: '2026-10-09T13:00:00.000Z', timeZone: 'Europe/Prague' },
    });
});

test('same-version Drive pairing acknowledgement fills metadata without changing content or revision', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 100 });
    const created = await service.createTask({ task: task(), context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui } });
    assert.equal(created.status, 'applied');
    const calendar = { accountId: 'account-a', calendarId: 'primary', eventId: 'event', canonicalIdentity: `public:${created.task.publicId}`, origin: 'local' as const, generation: 0, metadataUpdatedAt: 200 };
    await service.importTask({ task: { ...created.task, calendar }, localId: created.task.id,
        context: { actor: 'battleplan-drive', origin: 'drive', causeId: CAUSES.drive } });
    const saved = await db.tasks.get(created.task.id!);
    assert.deepEqual(saved?.calendar, calendar);
    assert.equal(saved?.updatedAt, 100);
    assert.deepEqual(saved?.protocolRevision, created.task.protocolRevision);
    assert.equal(await db.agentProtocolEvents.count(), 1);
    assert.equal(await db.agentProtocolEffects.count(), 0);
});

test('opt-in excludes unselected history and fallback tasks, exports new/edited plans for every author, and never echoes imports', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    const scheduled = { ...task(), deadline: '2026-10-09', startTime: '15:00', duration: 60 };
    const historical = await service.createTask({ task: scheduled, context: authored });
    assert.equal(historical.status, 'applied');
    assert.equal(await db.agentProtocolEffects.count(), 0, 'disabled by default');
    await writeCalendarSyncSettings(db, { ...settings, enrolledPublicIds: ['selected-history'] });
    assert.equal(await db.agentProtocolEffects.count(), 0, 'activation does not scan/export all history');
    assert.equal(isCalendarHistoryEnrolled(historical.task, settings), false);
    assert.equal(isCalendarHistoryEnrolled({ publicId: 'selected-history' }, { ...settings, enrolledPublicIds: ['selected-history'] }), true);
    for (const origin of ['ui', 'voice', 'hermes'] as const) {
        await service.createTask({ task: scheduled, context: { ...authored, origin } });
    }
    await service.updateTask({ localId: historical.task.id, changes: { title: 'Authored edit of history' }, context: authored });
    assert.equal(await db.agentProtocolEffects.count(), 4);
    const fallback = await service.createTask({ task: ensureTaskDeadline({ ...task(), startTime: '10:00' }), context: authored });
    assert.equal(fallback.status, 'applied');
    await service.updateTask({ localId: fallback.task.id, changes: { duration: 30, title: 'Capture edit' }, context: authored });
    await service.importTask({ task: { ...scheduled, publicId: 'from-drive', createdAt: 1, updatedAt: 1 }, context: { ...authored, origin: 'drive' } });
    await service.createTask({ task: scheduled, effects: [{ kind: 'calendar', operation: 'upsert' }], context: { ...authored, origin: 'google' } });
    assert.equal(await db.agentProtocolEffects.count(), 4, 'implicit Friday and inbound writes are not export intent');
    await service.updateTask({ localId: fallback.task.id, changes: { deadline: '2026-10-12', startTime: '16:00' }, context: authored });
    assert.equal(await db.agentProtocolEffects.count(), 5, 'later authored schedule enrolls the fallback row');
});

test('two independent databases reserve one canonical occurrence target and retain assigned legacy IDs', async (t) => {
    const first = await database(t), second = await database(t);
    const ids: string[] = [];
    for (const [db, publicId] of [[first, 'device-a'], [second, 'device-b']] as const) {
        await writeCalendarSyncSettings(db, settings);
        const result = await new TaskMutationService(db).createTask({ task: { ...task(), publicId, suggestionOccurrenceKey: 'shared', deadline: '2026-10-09', isAllDay: true }, context: authored });
        assert.equal(result.status, 'applied');
        ids.push(result.task.reservedGoogleEventId!);
    }
    assert.equal(ids[0], ids[1]);
    const service = new TaskMutationService(first);
    const legacy = await service.importTask({ task: { ...task(), publicId: 'legacy-linked', deadline: '2026-10-09', isAllDay: true, googleEventId: 'original-id', createdAt: 1, updatedAt: 1 }, context: { ...authored, origin: 'drive' } });
    assert.equal(legacy.status, 'applied');
    const updated = await service.updateTask({ localId: legacy.task.id, changes: { title: 'Edited' }, context: authored });
    assert.equal(updated.status, 'applied');
    assert.equal(updated.task.reservedGoogleEventId, 'original-id');
});

test('all authored writes and manual queue reject readonly rows; inbound changes are permitted', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    const calendar = { accountId: 'account-a', calendarId: 'primary', eventId: 'readonly', canonicalIdentity: 'google:readonly', origin: 'google' as const, generation: 0, metadataUpdatedAt: 1, readonlyReason: 'recurring' as const };
    const imported = await service.importTask({ task: { ...task(), publicId: 'readonly', calendar, createdAt: 1, updatedAt: 1 }, context: { ...authored, origin: 'google' } });
    assert.equal(imported.status, 'applied');
    for (const origin of ['ui', 'voice', 'hermes'] as const) {
        const input = { localId: imported.task.id, context: { ...authored, origin } };
        await assert.rejects(service.updateTask({ ...input, changes: { title: 'Forbidden' } }), /calendar_task_readonly/);
        await assert.rejects(service.completeTask(input), /calendar_task_readonly/);
        await assert.rejects(service.archiveTask(input), /calendar_task_readonly/);
        await assert.rejects(service.queueEffects({ ...input, effects: [{ kind: 'calendar', operation: 'upsert' }] }), /calendar_task_readonly/);
    }
    await service.importTask({ task: { ...imported.task, title: 'Google changed it', updatedAt: 2 }, localId: imported.task.id, context: { ...authored, origin: 'google' } });
    assert.equal((await db.tasks.get(imported.task.id!))?.title, 'Google changed it');
    assert.equal(await db.agentProtocolEffects.count(), 0);
});

test('suppression blocks automatic linked effects; explicit restoration advances target generation', async (t) => {
    const db = await database(t);
    await writeCalendarSyncSettings(db, settings);
    const service = new TaskMutationService(db);
    const calendar = { accountId: 'account-a', calendarId: 'primary', eventId: 'cancelled', canonicalIdentity: 'public:suppressed', origin: 'local' as const, generation: 0, metadataUpdatedAt: 1, suppressed: true };
    const imported = await service.importTask({ task: { ...task(), publicId: 'suppressed', calendar, reservedGoogleEventId: 'cancelled', deadline: '2026-10-09', isAllDay: true, createdAt: 1, updatedAt: 1 }, context: { ...authored, origin: 'drive' } });
    assert.equal(imported.status, 'applied');
    await service.updateTask({ localId: imported.task.id, changes: { title: 'Still local', calendar: { ...calendar, suppressed: false } }, effects: [{ kind: 'calendar', operation: 'upsert' }], context: authored });
    assert.equal(await db.agentProtocolEffects.count(), 0);
    await service.queueEffects({ localId: imported.task.id, effects: [{ kind: 'calendar', operation: 'upsert' }], context: authored });
    const restored = (await db.tasks.get(imported.task.id!))!;
    assert.equal(restored.calendar?.generation, 1);
    assert.equal(restored.calendar?.suppressed, false);
    assert.notEqual(restored.reservedGoogleEventId, 'cancelled');
    assert.equal(await db.agentProtocolEffects.count(), 1);
});

test('queued edits carry previous local desired projection separately from acknowledged base', async (t) => {
    const db = await database(t);
    await writeCalendarSyncSettings(db, settings);
    const service = new TaskMutationService(db);
    const created = await service.createTask({ task: { ...task(), deadline: '2026-10-09', isAllDay: true }, context: authored });
    assert.equal(created.status, 'applied');
    await service.updateTask({ localId: created.task.id, changes: { description: 'Second queued intent' }, context: authored });
    await service.updateTask({ localId: created.task.id, changes: { title: 'Third queued intent' }, context: authored });
    const effects = (await db.agentProtocolEffects.toArray()).sort((a, b) => a.sequence - b.sequence);
    assert.ok(effects[0].kind === 'calendar' && effects[0].operation === 'upsert');
    assert.ok(effects[1].kind === 'calendar' && effects[1].operation === 'upsert');
    assert.ok(effects[2].kind === 'calendar' && effects[2].operation === 'upsert');
    assert.equal(effects[0].payload.previousProjection, undefined);
    assert.deepEqual(effects[1].payload.previousProjection, effects[0].payload.projection);
    assert.deepEqual(effects[2].payload.previousProjection, effects[1].payload.projection);
    assert.equal(effects[2].payload.baseline, undefined, 'pending create is not a remote acknowledgement');
});

test('opt-in settings, task and automatically generated effect roll back together', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    await assert.rejects(db.transaction('rw', taskMutationTables(db), async () => {
        await writeCalendarSyncSettings(db, settings);
        await service.createTask({ task: { ...task(), deadline: '2026-10-09', isAllDay: true }, context: authored });
        assert.equal(await db.agentProtocolEffects.count(), 1);
        throw new Error('activation-rollback');
    }), /activation-rollback/);
    assert.equal(await db.tasks.count(), 0);
    assert.equal(await db.settings.count(), 0);
    assert.equal(await db.agentProtocolEffects.count(), 0);
});

test('a newer acknowledgement baseline survives stale editor fields and is included in the next effect', async (t) => {
    const db = await database(t);
    await writeCalendarSyncSettings(db, settings);
    const service = new TaskMutationService(db);
    const created = await service.createTask({ task: { ...task(), deadline: '2026-10-09', isAllDay: true }, context: authored });
    assert.equal(created.status, 'applied');
    const baseline = { title: 'Google acknowledgement', description: 'Public Google detail', timing: { kind: 'all-day' as const, startDate: '2026-10-09', endDate: '2026-10-10' } };
    const calendar = { ...created.task.calendar!, baseline, etag: 'acknowledged-etag', timing: baseline.timing, metadataUpdatedAt: Date.now() + 1 };
    await db.tasks.update(created.task.id!, { calendar });
    const result = await service.updateTask({ localId: created.task.id, changes: { title: 'New authored title', calendar: created.task.calendar }, context: authored });
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.task.calendar, calendar);
    const effects = (await db.agentProtocolEffects.toArray()).sort((a, b) => a.sequence - b.sequence);
    assert.ok(effects[1].kind === 'calendar' && effects[1].operation === 'upsert');
    assert.deepEqual(effects[1].payload.baseline, baseline);
    assert.equal(effects[1].payload.etag, 'acknowledged-etag');
    assert.equal((await db.agentProtocolEvents.toArray()).at(-1)?.projection.calendar, undefined);
});

test('explicitly confirming the same fallback date enrolls it and a stale false draft cannot undo that choice', async (t) => {
    const db = await database(t);
    await writeCalendarSyncSettings(db, settings);
    const service = new TaskMutationService(db);
    const created = await service.createTask({ task: ensureTaskDeadline({ ...task(), startTime: '15:00' }), context: authored });
    assert.equal(created.status, 'applied');
    assert.equal(created.task.calendarScheduleExplicit, false);
    assert.equal(await db.agentProtocolEffects.count(), 0);
    const enrolled = await service.updateTask({ localId: created.task.id, changes: { date: created.task.date, deadline: created.task.deadline, calendarScheduleExplicit: true }, context: authored });
    assert.equal(enrolled.status, 'applied');
    assert.equal(enrolled.task.calendarScheduleExplicit, true);
    assert.equal(await db.agentProtocolEffects.count(), 1);
    const staleFlag = await service.updateTask({ localId: created.task.id, changes: { title: 'Later draft', calendarScheduleExplicit: false }, context: authored });
    assert.equal(staleFlag.status, 'applied');
    assert.equal(staleFlag.task.calendarScheduleExplicit, true);
});

function task(title = 'Atomic task'): Omit<Task, 'id' | 'publicId' | 'protocolRevision' | 'createdAt' | 'updatedAt'> {
    return { title, description: 'Visible detail', internalNotes: 'PRIVATE RAW TRANSCRIPT', type: 'task', urgency: 2, status: 'pending' };
}

async function database(t: { after: (fn: () => Promise<void>) => void }): Promise<BattlePlanDB> {
    const db = new BattlePlanDB(`TaskMutations-${crypto.randomUUID()}`);
    await db.open();
    t.after(async () => db.delete());
    return db;
}

test('a legacy null revision admits only one concurrent guarded mutation', async (t) => {
    const db = await database(t);
    const id = await db.tasks.add({ ...task(), createdAt: 1, updatedAt: 1 });
    const service = new TaskMutationService(db);
    const results = await Promise.all(['First', 'Second'].map((title) => service.updateTask({
        localId: id, expectedRevision: null, changes: { title },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: crypto.randomUUID() },
    })));
    assert.deepEqual(results.map((result) => result.status).sort(), ['applied', 'stale']);
    assert.equal(await db.agentProtocolEvents.count(), 1);
});

test('pending Calendar create, edit and archive keep one target with durable order', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const created = await service.createTask({
        task: { ...task(), type: 'meeting', totalDuration: 90, suggestionSubjectId: 'subject', suggestionOccurrenceKey: 'occurrence' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    assert.equal(created.status, 'applied');
    assert.equal(created.task.suggestionSubjectId, 'subject');
    assert.equal(created.task.suggestionOccurrenceKey, 'occurrence');
    await service.updateTask({ localId: created.task.id, changes: { title: 'Edited' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.voice },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    await service.archiveTask({ localId: created.task.id,
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.hermes },
        effects: [{ kind: 'calendar', operation: 'delete' }],
    });
    const effects = (await db.agentProtocolEffects.toArray()).sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(effects.map((effect) => effect.sequence), [1, 2, 3]);
    const reservation = created.task.reservedGoogleEventId!;
    assert.ok(reservation);
    assert.deepEqual(effects.map((effect) => 'reservedEventId' in effect.payload ? effect.payload.reservedEventId : 'eventId' in effect.payload ? effect.payload.eventId : undefined), [reservation, reservation, reservation]);
    assert.deepEqual(effects[0]!.payload, { type: 'meeting', publicId: created.task.publicId, canonicalIdentity: 'occurrence:occurrence', title: 'Atomic task', description: 'Visible detail', internalNotes: 'PRIVATE RAW TRANSCRIPT', totalDuration: 90, status: 'pending', reservedEventId: reservation });
    await applyTaskEffectMetadata(db, created.task.publicId!, reservation, reservation);
    assert.equal((await db.tasks.get(created.task.id!))?.googleEventId, undefined);
});

test('an enclosing transaction rolls back a persisted Calendar effect and surrounding work', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    await assert.rejects(db.transaction('rw', [...taskMutationTables(db), db.settings], async () => {
        await service.createTask({
            task: { ...task(), type: 'meeting' },
            context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
            effects: [{ kind: 'calendar', operation: 'upsert' }],
        });
        await db.settings.put({ id: 'outer', value: 'written' });
        assert.equal(await db.tasks.count(), 1);
        assert.equal(await db.agentProtocolEvents.count(), 1);
        assert.equal(await db.agentProtocolOutbox.count(), 1);
        assert.equal(await db.agentProtocolEffects.count(), 1);
        assert.equal(await db.agentEventStreams.count(), 1);
        assert.equal(await db.settings.count(), 1);
        throw new Error('outer-failure');
    }), /outer-failure/);
    assert.equal(await db.tasks.count(), 0);
    assert.equal(await db.agentProtocolEvents.count(), 0);
    assert.equal(await db.agentProtocolOutbox.count(), 0);
    assert.equal(await db.agentProtocolEffects.count(), 0);
    assert.equal(await db.agentEventStreams.count(), 0);
    assert.equal(await db.settings.count(), 0);
});

test('manual queue rejects stale state and does not collapse a changed desired payload', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    const created = await service.createTask({ task: { ...task(), type: 'meeting' }, context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui } });
    assert.equal(created.status, 'applied');
    const input = { localId: created.task.id, context: { actor: 'battleplan-user', origin: 'ui' as const, causeId: CAUSES.ui }, effects: [{ kind: 'calendar' as const, operation: 'upsert' as const }] };
    assert.equal((await service.queueEffects({ ...input, expectedRevision: null })).status, 'stale');
    await service.queueEffects(input);
    await service.updateTask({ localId: created.task.id, changes: { title: 'New desired title' }, context: input.context });
    await service.queueEffects(input);
    assert.equal(await db.agentProtocolEffects.count(), 2);
    await service.updateTask({ localId: created.task.id, changes: { title: 'Atomic task' }, context: input.context });
    await service.queueEffects(input);
    assert.equal(await db.agentProtocolEffects.count(), 3, 'returning to an earlier payload must queue after the intervening edit');
});

test('first explicit sync binds unbound effects and later account switches cannot rebind them', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    const context = { actor: 'battleplan-user', origin: 'ui' as const, causeId: CAUSES.ui };
    const effects = [{ kind: 'calendar' as const, operation: 'upsert' as const }];
    const created = await service.createTask({ task: { ...task(), type: 'meeting' }, context, effects });
    assert.equal(created.status, 'applied');
    assert.equal((await db.agentProtocolEffects.toArray())[0]?.accountId, undefined);
    await service.queueEffects({ localId: created.task.id, context: { ...context, googleAccountId: 'account-a' }, effects });
    const updated = await service.updateTask({ localId: created.task.id, changes: { title: 'Changed under B', googleAccountId: 'account-b' }, context: { ...context, googleAccountId: 'account-b' }, effects });
    assert.equal(updated.status, 'applied');
    assert.equal(updated.task.googleAccountId, 'account-a');
    assert.deepEqual((await db.agentProtocolEffects.toArray()).map((effect) => effect.accountId), ['account-a', 'account-a']);
    assert.equal((await db.agentProtocolEvents.toCollection().last())?.projection.googleAccountId, undefined);
});

test('imports preserve reserved target, account and sequence while accepting newer task content', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 100 });
    const created = await service.createTask({ task: { ...task(), type: 'meeting' }, context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui, googleAccountId: 'account-a' }, effects: [{ kind: 'calendar', operation: 'upsert' }] });
    assert.equal(created.status, 'applied');
    const imported = await service.importTask({ task: { ...created.task, title: 'Imported', updatedAt: 200, googleEventId: 'wrong', reservedGoogleEventId: 'wrong', googleAccountId: 'account-b', effectSequence: 0 }, localId: created.task.id, context: { actor: 'battleplan-drive', origin: 'drive', causeId: CAUSES.drive } });
    assert.equal(imported.status, 'applied');
    assert.equal(imported.task.title, 'Imported');
    assert.equal(imported.task.reservedGoogleEventId, created.task.reservedGoogleEventId);
    assert.equal(imported.task.googleEventId, undefined);
    assert.equal(imported.task.googleAccountId, 'account-a');
    assert.equal(imported.task.effectSequence, 1);
    assert.equal(await db.agentProtocolEffects.count(), 1);
});

test('deleted or mismatched local identity cannot be edited or recreated', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    const context = { actor: 'battleplan-user', origin: 'ui' as const, causeId: CAUSES.ui };
    const created = await service.createTask({ task: task(), context });
    assert.equal(created.status, 'applied');
    assert.equal((await service.updateTask({ localId: created.task.id! + 1, publicId: created.task.publicId, changes: { title: 'Wrong' }, context })).status, 'not_found');
    await service.archiveTask({ localId: created.task.id, context });
    assert.equal((await service.updateTask({ localId: created.task.id, changes: { isDeleted: false }, context })).status, 'not_found');
    await db.tasks.delete(created.task.id!);
    assert.equal((await service.updateTask({ localId: created.task.id, expectedRevision: null, changes: { title: 'Zombie' }, context })).status, 'not_found');
    assert.equal(await db.tasks.count(), 0);
});

test('linked Calendar effects stay durable while immediate execution is unavailable', () => {
    const linkedMeeting = { type: 'meeting' as const, googleEventId: 'calendar-event-1' };
    assert.deepEqual(calendarEffectsForLocalTask(linkedMeeting, 'upsert'), [
        { kind: 'calendar', operation: 'upsert' },
    ]);
    assert.deepEqual(calendarEffectsForLocalTask(linkedMeeting, 'delete'), [
        { kind: 'calendar', operation: 'delete' },
    ]);
    assert.deepEqual(calendarEffectsForLocalTask({ type: 'task', googleEventId: 'calendar-event-legacy' }, 'upsert'), [
        { kind: 'calendar', operation: 'upsert' },
    ]);

    const unlinkedMeeting = { type: 'meeting' as const, googleEventId: undefined };
    assert.deepEqual(calendarEffectsForLocalTask(unlinkedMeeting, 'upsert'), []);
    assert.deepEqual(calendarEffectsForLocalTask(unlinkedMeeting, 'upsert', true), [
        { kind: 'calendar', operation: 'upsert' },
    ]);
    assert.deepEqual(calendarEffectsForLocalTask(unlinkedMeeting, 'delete', true), []);
});

test('UI, voice, Hermes and Drive imports emit equivalent safe Task state with distinct context', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => Date.parse('2026-08-11T08:00:00Z') });

    for (const origin of ['ui', 'voice', 'hermes', 'drive'] as const) {
        const context = { actor: origin === 'hermes' ? 'hermes-agent' : 'battleplan-user', origin, causeId: CAUSES[origin] } as const;
        const result = origin === 'drive'
            ? await service.importTask({
                task: { ...task('Task from drive'), createdAt: 10, updatedAt: 20 },
                context,
            })
            : await service.createTask({ task: task(`Task from ${origin}`), context });
        assert.equal(result.status, 'applied');
    }

    const tasks = await db.tasks.toArray();
    const events = (await db.agentProtocolEvents.toArray()).sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)));
    assert.equal(tasks.length, 4);
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((event) => event.origin), ['ui', 'voice', 'hermes', 'drive']);
    assert.deepEqual(events.map((event) => event.causeId), Object.values(CAUSES));
    for (const [index, event] of events.entries()) {
        assert.equal(event.entityPublicId, tasks[index]!.publicId);
        assert.equal(event.revision.revision_id, tasks[index]!.protocolRevision?.revision_id);
        assert.equal(event.projection.title, tasks[index]!.title);
        assert.equal('id' in event.projection, false);
        assert.equal('internalNotes' in event.projection, false);
        assert.equal('agent_write_id' in event.projection, false);
    }
    assert.equal(await db.agentProtocolOutbox.where('family').equals('event').count(), 4);
});

test('Drive import never overwrites an unrelated Task that shares only a numeric local ID', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const localId = await db.tasks.add({
        publicId: 'task_local_identity', title: 'Local task', type: 'task', urgency: 2, status: 'pending', createdAt: 1, updatedAt: 10,
    });

    const imported = await service.importTask({
        task: {
            id: localId,
            publicId: 'task_remote_identity',
            title: 'Remote task', type: 'task', urgency: 2, status: 'pending', createdAt: 2, updatedAt: 20,
        },
        context: { actor: 'battleplan-drive', origin: 'drive', causeId: CAUSES.drive },
    });

    assert.equal(imported.status, 'applied');
    assert.equal(await db.tasks.count(), 2);
    assert.equal((await db.tasks.get(localId))?.title, 'Local task');
    assert.equal((await db.tasks.where('publicId').equals('task_remote_identity').first())?.title, 'Remote task');
});

test('Task, event, effect and event outbox roll back as one transaction', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, {
        now: () => Date.parse('2026-08-11T08:00:00Z'),
        beforeCommit: () => { throw new Error('injected-before-commit'); },
    });

    await assert.rejects(service.createTask({
        task: { ...task('Meeting'), type: 'meeting' },
        context: { actor: 'battleplan-user', origin: 'voice', causeId: CAUSES.voice },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    }), /injected-before-commit/);

    assert.equal(await db.tasks.count(), 0);
    assert.equal(await db.agentProtocolEvents.count(), 0);
    assert.equal(await db.agentProtocolOutbox.count(), 0);
    assert.equal(await db.agentProtocolEffects.count(), 0);
    assert.equal(await db.agentEventStreams.count(), 0);
});

test('expected revision mismatch is stale and changes no durable state', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => Date.parse('2026-08-11T08:00:00Z') });
    const created = await service.createTask({
        task: task(),
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');
    const countsBefore = {
        tasks: await db.tasks.count(), events: await db.agentProtocolEvents.count(), outbox: await db.agentProtocolOutbox.count(),
    };

    const stale = await service.updateTask({
        publicId: created.task.publicId!,
        expectedRevision: `sha256:${'f'.repeat(64)}`,
        changes: { title: 'Must not win' },
        context: { actor: 'hermes-agent', origin: 'hermes', causeId: CAUSES.hermes },
    });

    assert.equal(stale.status, 'stale');
    assert.equal((await db.tasks.get(created.task.id!))?.title, 'Atomic task');
    assert.deepEqual({
        tasks: await db.tasks.count(), events: await db.agentProtocolEvents.count(), outbox: await db.agentProtocolOutbox.count(),
    }, countsBefore);
});

test('caller-owned update input is snapshotted before the first asynchronous read', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const created = await service.createTask({
        task: task('Original title'),
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');
    const changes: Partial<Task> = { title: 'Submitted title' };
    const context = { actor: 'battleplan-user', origin: 'ui' as const, causeId: CAUSES.voice };

    const pending = service.updateTask({ localId: created.task.id, changes, context });
    changes.title = 'Attacker-raced title';
    context.actor = 'attacker-raced-actor';

    const result = await pending;
    assert.equal(result.status, 'applied');
    if (result.status !== 'applied') return;
    assert.equal(result.task.title, 'Submitted title');
    const event = await db.agentProtocolEvents.where('entityPublicId').equals(result.task.publicId!).last();
    assert.equal(event?.actor, 'battleplan-user');
});

test('Calendar metadata is protected from stale caller fields', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db);
    const created = await service.createTask({
        task: { ...task(), type: 'meeting' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
    });
    assert.equal(created.status, 'applied');
    const reservation = created.task.reservedGoogleEventId!;
    await applyTaskEffectMetadata(db, created.task.publicId!, reservation, reservation);
    const updated = await service.updateTask({
        localId: created.task.id, changes: { title: 'New title', googleEventId: 'wrong', reservedGoogleEventId: 'wrong' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.voice },
    });
    assert.equal(updated.status, 'applied');
    assert.equal(updated.task.googleEventId, reservation);
    assert.equal(updated.task.reservedGoogleEventId, reservation);
    await applyTaskEffectMetadata(db, created.task.publicId!, 'different', reservation);
    assert.equal((await db.tasks.get(created.task.id!))?.googleEventId, reservation);
});

test('overlapping manual sync requests share one active durable effect', async (t) => {
    const db = await database(t);
    const service = new TaskMutationService(db, { now: () => 1_000 });
    const created = await service.createTask({
        task: { ...task('Manual sync'), type: 'meeting' },
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');

    const [first, second] = await Promise.all([
        service.queueEffects({
            publicId: created.task.publicId,
            context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
            effects: [{ kind: 'calendar', operation: 'upsert' }],
        }),
        service.queueEffects({
            publicId: created.task.publicId,
            context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.voice },
            effects: [{ kind: 'calendar', operation: 'upsert' }],
        }),
    ]);

    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    assert.equal(await db.agentProtocolEffects.count(), 1);
    if (first.status === 'queued' && second.status === 'queued') assert.deepEqual(first.effectIds, second.effectIds);
});

test('a fenced Hermes command commits receipt, Task, event, result and effect atomically', async (t) => {
    const db = await database(t);
    const now = 1_000;
    await db.agentReceiverCapabilities.put({
        receiverId: 'battleplan-receiver-a', enabled: true, status: 'ready', persistenceStatus: 'granted', updatedAt: now,
    });
    const ledger = new AgentProtocolLedger(db, () => now);
    const claimed = await ledger.claimCommand({
        commandId: '018f6f5e-2d88-7f2a-8f90-d6ad23001010',
        payloadDigest: `sha256:${'a'.repeat(64)}`,
        producerId: 'hermes-agent',
        targetReceiverId: 'battleplan-receiver-a',
        localReceiverId: 'battleplan-receiver-a',
        expiresAt: 10_000,
        leaseOwner: 'tab-a',
        leaseDurationMs: 5_000,
    });
    assert.equal(claimed.status, 'claimed');
    if (claimed.status !== 'claimed') return;
    const service = new TaskMutationService(db, { now: () => now });

    const result = await service.createTask({
        task: { ...task('Hermes meeting'), type: 'meeting' },
        context: { actor: 'hermes-agent', origin: 'hermes', causeId: CAUSES.hermes },
        effects: [{ kind: 'calendar', operation: 'upsert' }],
        command: { ledger, claim: claimed.claim },
    });

    assert.equal(result.status, 'applied');
    assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'applied');
    assert.equal(await db.tasks.count(), 1);
    assert.equal(await db.agentProtocolEvents.count(), 1);
    assert.equal(await db.agentProtocolEffects.count(), 1);
    assert.equal(await db.agentProtocolOutbox.where('family').equals('result').count(), 1);
    assert.equal(await db.agentProtocolOutbox.where('family').equals('event').count(), 1);
    const effect = await db.agentProtocolEffects.toCollection().first();
    assert.equal(effect?.commandReceiptId, claimed.claim.receiptId);
});

test('a stale fenced Hermes update finalizes its receipt without Task or event mutation', async (t) => {
    const db = await database(t);
    const now = 1_000;
    const service = new TaskMutationService(db, { now: () => now });
    const created = await service.createTask({
        task: task(),
        context: { actor: 'battleplan-user', origin: 'ui', causeId: CAUSES.ui },
    });
    assert.equal(created.status, 'applied');
    await db.agentReceiverCapabilities.put({
        receiverId: 'battleplan-receiver-a', enabled: true, status: 'ready', persistenceStatus: 'granted', updatedAt: now,
    });
    const ledger = new AgentProtocolLedger(db, () => now);
    const claimed = await ledger.claimCommand({
        commandId: '018f6f5e-2d88-7f2a-8f90-d6ad23001011',
        payloadDigest: `sha256:${'b'.repeat(64)}`,
        producerId: 'hermes-agent', targetReceiverId: 'battleplan-receiver-a', localReceiverId: 'battleplan-receiver-a',
        expiresAt: 10_000, leaseOwner: 'tab-a', leaseDurationMs: 5_000,
    });
    assert.equal(claimed.status, 'claimed');
    if (claimed.status !== 'claimed') return;
    const eventsBefore = await db.agentProtocolEvents.count();

    const stale = await service.updateTask({
        publicId: created.task.publicId,
        expectedRevision: `sha256:${'f'.repeat(64)}`,
        changes: { title: 'Must not apply' },
        context: { actor: 'hermes-agent', origin: 'hermes', causeId: CAUSES.hermes },
        command: { ledger, claim: claimed.claim },
    });

    assert.equal(stale.status, 'stale');
    assert.equal((await db.tasks.get(created.task.id!))?.title, 'Atomic task');
    assert.equal(await db.agentProtocolEvents.count(), eventsBefore);
    assert.equal((await db.agentCommandReceipts.get(claimed.claim.receiptId))?.lifecycle, 'stale');
    const result = await db.agentProtocolOutbox.where('commandReceiptId').equals(claimed.claim.receiptId).first();
    assert.deepEqual(result?.payload, { command_id: claimed.claim.commandId, state: 'stale', error_code: 'revision_stale' });
});
