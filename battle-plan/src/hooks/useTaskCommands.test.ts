import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db, type Task } from '../db.ts';
import type { GoogleAuthStatus, UnifiedTask } from '../types.ts';
import { applySavedEditorStatus } from '../utils/editorInteraction.ts';

Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
});
const { useTaskCommands } = await import('./useTaskCommands.ts');
const { googleService } = await import('../services/googleService.ts');

beforeEach(async () => {
    await db.tasks.clear();
    await db.agentProtocolEvents.clear();
    await db.agentProtocolEffects.clear();
});
Object.defineProperty(globalThis, 'alert', { configurable: true, value: () => {} });
Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => true });
after(() => db.close());
afterEach(() => mock.restoreAll());

const draft = (changes: Partial<UnifiedTask> = {}): UnifiedTask => ({
    title: '  Ručně vytvořený úkol  ', type: 'task', urgency: 2,
    status: 'pending', createdAt: 1, updatedAt: 1, ...changes,
});

function commandsFor(editingTask: UnifiedTask | null, googleAuth: GoogleAuthStatus = { state: 'SIGNED_OUT', accessToken: null }) {
    let commands!: ReturnType<typeof useTaskCommands>;
    function Probe() {
        // Test-only capture from synchronous SSR; no component rerenders or UI reads this variable.
        commands = useTaskCommands({
            googleAuth, activeTaskList: '@default', editingTask,
            setEditingTask: () => {}, setGoogleTasksRaw: () => {}, setIsProcessing: () => {},
        });
        return null;
    }
    renderToStaticMarkup(createElement(Probe));
    return commands;
}

test('opening a draft creates no row and two simultaneous saves insert exactly one normalized task', async () => {
    const commands = commandsFor(draft());
    assert.equal(await db.tasks.count(), 0);
    const outcomes = await Promise.all([commands.handleSaveEdit(), commands.handleSaveEdit()]);
    assert.deepEqual(outcomes, [{ status: 'success' }, { status: 'success' }]);
    const rows = await db.tasks.toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Ručně vytvořený úkol');
    assert.match(rows[0].deadline!, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${rows[0].deadline}T12:00:00`).getDay(), 5);
    assert.ok(rows[0].publicId);
    assert.equal(rows[0].source, 'user');
    assert.ok(rows[0].protocolRevision);
    assert.equal(await db.agentProtocolEvents.count(), 1);
});

test('blank title fails without creating or overwriting a task', async () => {
    assert.equal((await commandsFor(draft({ title: '  ' })).handleSaveEdit()).status, 'failed');
    assert.equal(await db.tasks.count(), 0);
    const id = await db.tasks.add(draft({ title: 'Ponechat' }));
    assert.equal((await commandsFor(draft({ id, title: ' ' })).handleSaveEdit()).status, 'failed');
    assert.equal((await db.tasks.get(id))?.title, 'Ponechat');
});

test('saving missing and deleted tasks fails instead of pretending the draft was saved', async () => {
    assert.equal((await commandsFor(draft({ id: 999 })).handleSaveEdit()).status, 'failed');
    const id = await db.tasks.add(draft({ isDeleted: true }));
    assert.equal((await commandsFor(draft({ id, title: 'Nový název' })).handleSaveEdit()).status, 'failed');
    assert.equal((await db.tasks.get(id))?.isDeleted, true);
});

test('new thought stays undated and new meeting keeps its chosen date', async () => {
    assert.equal((await commandsFor(draft({ type: 'thought' })).handleSaveEdit()).status, 'success');
    assert.equal((await commandsFor(draft({ type: 'meeting', date: '2026-10-02' })).handleSaveEdit()).status, 'success');
    const rows = await db.tasks.toArray();
    assert.equal(rows[0].deadline, undefined);
    assert.equal(rows[0].date, undefined);
    assert.equal(rows[1].date, '2026-10-02');
});

test('calendar failure after a local create returns a warning and keeps exactly one saved meeting', async () => {
    mock.method(googleService, 'getAccountId', () => 'user@example.com');
    mock.method(googleService, 'getAuthStatus', () => ({ state: 'SIGNED_IN', accessToken: 'test' }));
    const sync = mock.method(googleService, 'addToCalendar', async (task: Task): Promise<string | null> => {
        assert.ok(task.reservedGoogleEventId);
        throw new Error('Offline');
    });
    const log = mock.method(console, 'error', () => {});
    try {
        const outcome = await commandsFor(draft({ type: 'meeting', date: '2026-10-02' }), { state: 'SIGNED_IN', accessToken: 'test' }).handleSaveEdit();
        assert.equal(outcome.status, 'success-sync-warning');
        assert.equal(await db.tasks.count(), 1);
        assert.equal(sync.mock.calls.length, 1);
        assert.ok(sync.mock.calls[0].arguments[0].reservedGoogleEventId);
        const effects = await db.agentProtocolEffects.toArray();
        assert.equal(effects[0].state, 'retry_scheduled');
        assert.equal(effects[0].accountId, 'user@example.com');
    } finally {
        sync.mock.restore();
        log.mock.restore();
    }
});

test('failed local create leaves the draft unchanged and permits a successful retry', async () => {
    const original = draft();
    const commands = commandsFor(original);
    const failCreate = () => { throw new Error('Storage unavailable'); };
    db.tasks.hook('creating', failCreate);
    try {
        await assert.rejects(commands.handleSaveEdit(), /Storage unavailable/);
        assert.equal(original.id, undefined);
        assert.equal(await db.tasks.count(), 0);
        assert.equal(await db.agentProtocolEvents.count(), 0);
        assert.equal(await db.agentProtocolEffects.count(), 0);
    } finally {
        db.tasks.hook('creating').unsubscribe(failCreate);
    }
    assert.equal((await commands.handleSaveEdit()).status, 'success');
    assert.equal(await db.tasks.count(), 1);
});

test('completion only persists status and refuses a missing or deleted row', async () => {
    const id = await db.tasks.add(draft({ title: 'Uložený název' }));
    const stored = (await db.tasks.get(id))!;
    const dirty = { ...stored, title: 'Rozepsaný název' };
    const commands = commandsFor(dirty);
    const updated = await commands.handleToggleTask(dirty);
    assert.equal(updated?.status, 'completed');
    assert.equal((await db.tasks.get(id))?.title, 'Uložený název');
    assert.ok(updated?.protocolRevision);
    assert.equal(await db.agentProtocolEvents.count(), 1);
    await db.tasks.update(id, { isDeleted: true });
    assert.equal(await commands.handleToggleTask(dirty), null);
    await db.tasks.delete(id);
    assert.equal(await commands.handleToggleTask(dirty), null);
});

test('status and subtask toggles read the latest saved value instead of stale render data', async () => {
    const id = await db.tasks.add(draft({
        subTasks: [{ id: 'one', title: 'First step', completed: false }], duration: 60, totalDuration: 60,
    }));
    const original = (await db.tasks.get(id))!;
    const commands = commandsFor(original);
    assert.equal((await commands.handleToggleTask(original))?.status, 'completed');
    assert.equal((await commands.handleToggleTask(original))?.status, 'pending');
    await commands.toggleSubtask(original, 'one');
    assert.equal((await db.tasks.get(id))?.progress, 100);
    await commands.toggleSubtask(original, 'one');
    const saved = (await db.tasks.get(id))!;
    assert.equal(saved.progress, 0);
    assert.equal(saved.duration, 60);
    assert.equal(await db.agentProtocolEvents.count(), 4);
});

test('archive uses the current reserved Calendar target and refuses reused local identity', async () => {
    const id = await db.tasks.add(draft({ type: 'meeting', reservedGoogleEventId: 'reserved-event' }));
    const original = (await db.tasks.get(id))!;
    const commands = commandsFor(original);
    assert.equal(await commands.handleDeleteTask({ ...original, publicId: 'task_different' }), false);
    assert.equal(await commands.handleDeleteTask(original), true);
    const effects = await db.agentProtocolEffects.toArray();
    assert.equal((await db.tasks.get(id))?.isDeleted, true);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].operation, 'delete');
    if (effects[0].kind === 'calendar' && effects[0].operation === 'delete') {
        assert.equal(effects[0].payload.eventId, 'reserved-event');
    }
});

test('explicit Google sync binds a previously unbound effect to the selected account', async () => {
    const id = await db.tasks.add(draft({ type: 'meeting', googleEventId: 'linked-event', date: '2026-10-02' }));
    const original = (await db.tasks.get(id))!;
    await commandsFor({ ...original, title: 'Offline edit' }).handleSaveEdit();
    assert.equal((await db.agentProtocolEffects.toArray())[0].accountId, undefined);
    mock.method(googleService, 'getAccountId', () => 'selected@example.com');
    // Authentication still waits, so this tests binding without a network request.
    await commandsFor(original).handleSyncToGoogle(original);
    const effects = await db.agentProtocolEffects.toArray();
    assert.equal(effects.length, 1);
    assert.equal(effects[0].accountId, 'selected@example.com');
    assert.equal((await db.tasks.get(id))?.googleAccountId, 'selected@example.com');
});

test('Google-only tasks keep direct completion without a local mutation or effect', async () => {
    const update = mock.method(googleService, 'updateGoogleTask', async () => ({ id: 'google-only' }));
    mock.method(googleService, 'getTasks', async () => []);
    const googleOnly = draft({ isGoogleTask: true, googleId: 'google-only' });
    const result = await commandsFor(googleOnly, { state: 'SIGNED_IN', accessToken: 'test' }).handleToggleTask(googleOnly);
    assert.equal(result?.status, 'completed');
    assert.equal(update.mock.calls.length, 1);
    assert.equal(await db.tasks.count(), 0);
    assert.equal(await db.agentProtocolEvents.count(), 0);
    assert.equal(await db.agentProtocolEffects.count(), 0);
});

test('stale editor cannot overwrite a task changed after opening', async () => {
    const id = await db.tasks.add(draft({ title: 'Původní název' }));
    const original = (await db.tasks.get(id))!;
    const staleEditor = commandsFor({ ...original, title: 'Zastaralý název' });
    assert.equal((await commandsFor({ ...original, title: 'Novější název' }).handleSaveEdit()).status, 'success');
    assert.equal((await staleEditor.handleSaveEdit()).status, 'failed');
    assert.equal((await db.tasks.get(id))?.title, 'Novější název');
    assert.equal(await db.agentProtocolEvents.count(), 1);
});

test('completion cannot authorize a stale draft to overwrite a newer title or schedule', async () => {
    assert.equal((await commandsFor(draft({
        title: 'Original title', deadline: '2026-10-02', startTime: '09:00',
    })).handleSaveEdit()).status, 'success');
    const opened = (await db.tasks.toArray())[0];
    const dirty = { ...opened, description: 'Unsaved editor notes' };

    assert.equal((await commandsFor({
        ...opened, title: 'Newer title', deadline: '2026-10-05', startTime: '14:00',
    }).handleSaveEdit()).status, 'success');
    const completed = await commandsFor(dirty).handleToggleTask(dirty);
    assert.ok(completed);
    const draftAfterCompletion = applySavedEditorStatus(dirty, completed);
    const beforeSave = (await db.tasks.get(opened.id!))!;
    assert.equal(beforeSave.title, 'Newer title');
    assert.equal(beforeSave.deadline, '2026-10-05');
    assert.equal(beforeSave.startTime, '14:00');
    assert.equal(beforeSave.status, 'completed');
    assert.equal(draftAfterCompletion.description, 'Unsaved editor notes');

    assert.equal((await commandsFor(draftAfterCompletion).handleSaveEdit()).status, 'failed');
    assert.deepEqual(await db.tasks.get(opened.id!), beforeSave);
    assert.equal(await db.agentProtocolEvents.count(), 3);
});

test('completion of a current editor draft still permits saving its unsaved text', async () => {
    assert.equal((await commandsFor(draft({ title: 'Saved title' })).handleSaveEdit()).status, 'success');
    const opened = (await db.tasks.toArray())[0];
    const dirty = { ...opened, title: 'Unsaved title', description: 'Unsaved editor notes' };
    const completed = await commandsFor(dirty).handleToggleTask(dirty);
    assert.ok(completed);
    const draftAfterCompletion = applySavedEditorStatus(dirty, completed);

    assert.equal((await commandsFor(draftAfterCompletion).handleSaveEdit()).status, 'success');
    const saved = (await db.tasks.get(opened.id!))!;
    assert.equal(saved.title, 'Unsaved title');
    assert.equal(saved.description, 'Unsaved editor notes');
    assert.equal(saved.status, 'completed');
    assert.equal(await db.agentProtocolEvents.count(), 3);
});

test('editing a linked meeting while signed out commits its change and durable Calendar effect', async () => {
    const id = await db.tasks.add(draft({ type: 'meeting', googleEventId: 'existing-event', date: '2026-10-02' }));
    const original = (await db.tasks.get(id))!;
    const outcome = await commandsFor({ ...original, title: 'Offline edit' }).handleSaveEdit();
    assert.equal(outcome.status, 'success-sync-warning');
    assert.equal((await db.tasks.get(id))?.title, 'Offline edit');
    assert.equal(await db.agentProtocolEvents.count(), 1);
    const effects = await db.agentProtocolEffects.toArray();
    assert.equal(effects.length, 1);
    assert.equal(effects[0].kind, 'calendar');
    assert.equal(effects[0].operation, 'upsert');
    assert.notEqual(effects[0].state, 'succeeded');
});
