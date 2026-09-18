import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { db, type Task } from '../db.ts';
import type { GoogleAuthStatus, UnifiedTask } from '../types.ts';

Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
});
const { useTaskCommands } = await import('./useTaskCommands.ts');
const { googleService } = await import('../services/googleService.ts');

beforeEach(() => db.tasks.clear());
after(() => db.close());

const draft = (changes: Partial<UnifiedTask> = {}): UnifiedTask => ({
    title: '  Ručně vytvořený úkol  ', type: 'task', urgency: 2,
    status: 'pending', createdAt: 1, updatedAt: 1, ...changes,
});

function commandsFor(editingTask: UnifiedTask | null, googleAuth: GoogleAuthStatus = { state: 'SIGNED_OUT', accessToken: null }) {
    let commands!: ReturnType<typeof useTaskCommands>;
    function Probe() {
        // Test-only capture from synchronous SSR; no component rerenders or UI reads this variable.
        // eslint-disable-next-line react-hooks/globals -- SSR does not run effects; preserve the real hook and its refs.
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
    const sync = mock.method(googleService, 'addToCalendar', async (task: Task): Promise<string | null> => {
        assert.ok(task.id);
        throw new Error('Offline');
    });
    const log = mock.method(console, 'error', () => {});
    try {
        const outcome = await commandsFor(draft({ type: 'meeting', date: '2026-10-02' }), { state: 'SIGNED_IN', accessToken: 'test' }).handleSaveEdit();
        assert.equal(outcome.status, 'success-sync-warning');
        assert.equal(await db.tasks.count(), 1);
        assert.equal(sync.mock.calls.length, 1);
        assert.ok(sync.mock.calls[0].arguments[0].id);
    } finally {
        sync.mock.restore();
        log.mock.restore();
    }
});

test('failed local create leaves the draft unchanged and permits a successful retry', async () => {
    const original = draft();
    const commands = commandsFor(original);
    const add = mock.method(db.tasks, 'add', async () => { throw new Error('Storage unavailable'); });
    try {
        await assert.rejects(commands.handleSaveEdit(), /Storage unavailable/);
        assert.equal(original.id, undefined);
        assert.equal(await db.tasks.count(), 0);
    } finally {
        add.mock.restore();
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
    await db.tasks.update(id, { isDeleted: true });
    assert.equal(await commands.handleToggleTask(dirty), null);
    await db.tasks.delete(id);
    assert.equal(await commands.handleToggleTask(dirty), null);
});
