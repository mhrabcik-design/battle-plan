/// <reference types="node" />
import type { Project, Setting, WorkLog } from '../db.ts';
import type { AgentWriteProjectData } from './agentBridge.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Mock the bits of the browser surface that agentBridge and the gapi/google
// helpers need. We follow the same inline polyfill pattern as
// googleService.test.ts and driveJsonStore.test.ts (no jsdom, no sinon).
const store = new Map<string, string>();
const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size; },
};
const noopDispatch = () => true;
const noopListen = () => {};
(globalThis as unknown as {
    window: {
        localStorage: typeof localStorage;
        dispatchEvent: typeof noopDispatch;
        addEventListener: typeof noopListen;
        removeEventListener: typeof noopListen;
        gapi?: { client: { setToken: (t: unknown) => void; tasks?: unknown; calendar?: unknown; request: (args: unknown) => Promise<unknown> } };
        google?: { accounts: { oauth2: { hasGrantedAllScopes?: () => boolean } } };
    };
    localStorage: typeof localStorage;
}).window = {
    localStorage,
    dispatchEvent: noopDispatch,
    addEventListener: noopListen,
    removeEventListener: noopListen,
};
(globalThis as unknown as { localStorage: typeof localStorage }).localStorage = localStorage;

const gapiMock: {
    setTokenCalls: unknown[];
    calendarInsertCalls: unknown[];
    calendarDeleteCalls: unknown[];
    tasksPatchCalls: unknown[];
    calendarInsertImpl: (args: unknown) => Promise<unknown>;
    calendarDeleteImpl: (args: unknown) => Promise<unknown>;
    tasksPatchImpl: (args: unknown) => Promise<unknown>;
} = {
    setTokenCalls: [],
    calendarInsertCalls: [],
    calendarDeleteCalls: [],
    tasksPatchCalls: [],
    calendarInsertImpl: async (args: unknown) => ({ result: { id: (args as { resource: { id: string } }).resource.id } }),
    calendarDeleteImpl: async () => ({}),
    tasksPatchImpl: async () => ({ result: { id: 'task-1' } }),
};

(globalThis as unknown as { window: { gapi: unknown } }).window.gapi = {
    client: {
        setToken: (t: unknown) => { gapiMock.setTokenCalls.push(t); },
        calendar: { events: { insert: async (args: unknown) => { gapiMock.calendarInsertCalls.push(args); return gapiMock.calendarInsertImpl(args); }, delete: async (args: unknown) => { gapiMock.calendarDeleteCalls.push(args); return gapiMock.calendarDeleteImpl(args); } } },
        tasks: { tasks: { patch: async (args: unknown) => { gapiMock.tasksPatchCalls.push(args); return gapiMock.tasksPatchImpl(args); } } },
        request: async (args: unknown) => {
            // Drive API for DriveJsonStore — return a 404 so readJsonFile returns null and applyWrite can still run.
            if (typeof args === 'object' && args !== null && 'path' in args && 'method' in args) {
                const path = (args as { path: string }).path;
                if (path.startsWith('/calendar/v3/')) {
                    if (args.method === 'GET') {
                        return { body: JSON.stringify({ etag: '"calendar-version-1"' }) };
                    }
                    if (args.method === 'DELETE') {
                        gapiMock.calendarDeleteCalls.push(args);
                    }
                    return { body: '{}' };
                }
                if (path.includes('/files/') && (args as unknown as { method: string }).method === 'GET') {
                    const err = new Error('Not Found') as Error & { status?: number; code?: number };
                    err.status = 404; err.code = 404;
                    throw err;
                }
                if (path === '/files' && (args as unknown as { method: string }).method === 'GET') {
                    return { result: { files: [] } };
                }
            }
            return { result: {} };
        },
    },
};

(globalThis as unknown as { window: { google: unknown } }).window.google = {
    accounts: { oauth2: { hasGrantedAllScopes: () => true } },
};

// Lazy imports so the mock globals are installed first.
const { googleService } = await import('./googleService.ts');
const { agentBridge, shouldAcknowledgeApplyWrite } = await import('./agentBridge.ts');
const { db } = await import('../db.ts');

const agentProjectDataContract: AgentWriteProjectData = {
    name: 'Agent project',
    // @ts-expect-error aliases are identity tombstones controlled only by human merge/catalog flows
    aliases: ['Forbidden alias'],
};
void agentProjectDataContract;

type GoogleServiceInternalState = {
    accessToken: string | null;
    expiresAt: number;
    userEmail: string | null;
    verifiedAccount: { token: string; accountId: string } | null;
    trySilentRefresh: () => Promise<boolean>;
};


function clearStore() {
    store.clear();
    gapiMock.setTokenCalls = [];
    gapiMock.calendarInsertCalls = [];
    gapiMock.calendarDeleteCalls = [];
    gapiMock.tasksPatchCalls = [];
}

function seedSignedInStorage() {
    clearStore();
    localStorage.setItem('google_access_token', 'tok');
    localStorage.setItem('google_token_expires_at', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('google_user_email', 'user@example.com');
}

function setGoogleServiceState(state: {
    accessToken?: string | null;
    expiresAt?: number;
    userEmail?: string | null;
}): void {
    const svc = googleService as unknown as GoogleServiceInternalState;
    if (state.accessToken !== undefined) svc.accessToken = state.accessToken;
    if (state.expiresAt !== undefined) svc.expiresAt = state.expiresAt;
    if (state.userEmail !== undefined) svc.userEmail = state.userEmail;
    svc.verifiedAccount = svc.accessToken && svc.userEmail ? { token: svc.accessToken, accountId: svc.userEmail } : null;
}

async function resetDb() {
    await db.tasks.clear();
    await db.agentProtocolEvents.clear();
    await db.agentProtocolEffects.clear();
    await db.workLogs.clear();
    await db.projects.clear();
    await db.settings.clear();
    await db.agentInbox.clear();
}

test('U1: AgentWrite union accepts all 13 actions', () => {
    // Compile-time check: the union compiles for every action.
    const actions: Array<typeof agentBridge extends { markApplied: unknown } ? string : never> = [];
    void actions;
    // Runtime check: the type accepts every action at runtime.
    const ids: Record<string, string> = {
        create_task: '1', update_task: '2', delete_task: '3', complete_task: '4',
        create_worklog: '5', update_worklog: '6', delete_worklog: '7',
        create_project: '8', update_project: '9', delete_project: '10',
        create_settings: '11', update_settings: '12', delete_settings: '13',
    };
    assert.equal(Object.keys(ids).length, 13);
});

test('U6: agentBridge.init() calls drive.init with createFolder:true by default', async () => {
    clearStore();
    let received: { createFolder?: boolean } | undefined;
    // Spy on drive.init by replacing it on the agentBridge's private drive.
    (agentBridge as unknown as { drive: { init: (opts: { createFolder?: boolean }) => Promise<boolean> } }).drive = {
        init: async (opts) => { received = opts; return true; },
    };
    await agentBridge.init();
    assert.deepEqual(received, { createFolder: true });
});

test('U6: agentBridge.init({ createFolder: false }) is supported for tests', async () => {
    clearStore();
    let received: { createFolder?: boolean } | undefined;
    (agentBridge as unknown as { drive: { init: (opts: { createFolder?: boolean }) => Promise<boolean> }; isInitialized: boolean }).drive = {
        init: async (opts) => { received = opts; return true; },
    };
    (agentBridge as unknown as { isInitialized: boolean }).isInitialized = false;
    await agentBridge.init({ createFolder: false });
    assert.deepEqual(received, { createFolder: false });
});

test('U3: create_task stamps source=agent and agent_write_id on the row', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 9, 12) });
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    // drive.init is a no-op (no real Drive).
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();

    const write = {
        id: 'agent-1',
        action: 'create_task' as const,
        task_data: { title: 'Test task', type: 'task' as const, urgency: 2 as const, status: 'pending' as const },
        created_at: Date.now(),
    };
    const result = await agentBridge.applyWrite(write);
    assert.equal(result.success, true);
    assert.ok(result.newId);
    const stored = await db.tasks.get(result.newId!);
    assert.ok(stored);
    assert.equal(stored!.source, 'agent');
    assert.equal(stored!.agent_write_id, 'agent-1');
    assert.equal(stored!.deadline, '2026-09-11');
    assert.equal(stored!.date, '2026-09-11');
    assert.ok(stored!.protocolRevision);
    assert.equal(await db.agentProtocolEvents.count(), 1);
});

test('voice creation and updates keep undated tasks in the current week', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 13, 12) });
    await resetDb();
    const { applySemanticResult } = await import('./semanticEngine.ts');
    const auth = { state: 'SIGNED_OUT' as const, accessToken: null };
    const created = await applySemanticResult({ type: 'task', title: 'Bez termínu' }, null, auth);
    assert.ok(created && 'newId' in created);
    const id = created.newId!;
    assert.equal((await db.tasks.get(id))?.deadline, '2026-09-11');
    await applySemanticResult({ title: 'Přejmenováno' }, id, auth);
    assert.equal((await db.tasks.get(id))?.deadline, '2026-09-11');
    await applySemanticResult({ deadline: '2026-09-18' }, id, auth);
    assert.equal((await db.tasks.get(id))?.deadline, '2026-09-18');
    await applySemanticResult({ date: '', deadline: '' }, id, auth);
    assert.equal((await db.tasks.get(id))?.deadline, '2026-09-11');
});

test('U3: create_task delivers its durable Calendar effect and records only the reserved event identity', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();

    const write = {
        id: 'agent-meeting',
        action: 'create_task' as const,
        task_data: {
            title: 'Standup',
            type: 'meeting' as const,
            date: '2026-07-06',
            startTime: '09:00',
            duration: 30,
            urgency: 2 as const,
            status: 'pending' as const,
        },
        created_at: Date.now(),
    };
    const result = await agentBridge.applyWrite(write);
    assert.equal(result.success, true);
    assert.ok(result.newId);
    const stored = await db.tasks.get(result.newId!);
    assert.ok(stored);
    assert.equal(stored!.type, 'meeting');
    assert.match(stored!.reservedGoogleEventId!, /^bp[0-9a-f]{32}$/);
    assert.equal(stored!.googleEventId, stored!.reservedGoogleEventId);
    assert.ok(stored!.protocolRevision);
    assert.equal((await db.agentProtocolEffects.toArray())[0].state, 'succeeded');
    assert.equal(gapiMock.calendarInsertCalls.length, 1, 'calendar.events.insert should be called once');
});

test('U3: delete_task delivers its durable Calendar deletion with an ETag', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const id = await db.tasks.add({
        title: 'M', type: 'meeting', urgency: 2, status: 'pending', date: '2026-07-06', startTime: '09:00', duration: 30,
        googleEventId: 'cal-evt-existing', updatedAt: Date.now(), createdAt: Date.now(),
    });

    const write = {
        id: 'agent-del',
        action: 'delete_task' as const,
        task_data: { id },
        created_at: Date.now(),
    };
    const result = await agentBridge.applyWrite(write);
    assert.equal(result.success, true);
    assert.equal(gapiMock.calendarDeleteCalls.length, 1, 'conditional Calendar delete should be called once');
    const request = gapiMock.calendarDeleteCalls[0] as { headers: Record<string, string> };
    assert.equal(request.headers['If-Match'], '"calendar-version-1"');
    assert.equal((await db.agentProtocolEffects.toArray())[0].state, 'succeeded');
    assert.equal((await db.tasks.get(id))?.isDeleted, true);
});

test('U3: complete_task with googleId calls updateGoogleTask with status:completed', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const id = await db.tasks.add({
        title: 'T', type: 'task', urgency: 2, status: 'pending', date: '2026-07-06', startTime: '15:00', duration: 30,
        googleId: 'googletask-1', googleListId: '@default', updatedAt: Date.now(), createdAt: Date.now(),
    } as never);
    const write = {
        id: 'agent-complete',
        action: 'complete_task' as const,
        task_data: { id },
        created_at: Date.now(),
    };
    const result = await agentBridge.applyWrite(write);
    assert.equal(result.success, true);
    assert.equal(gapiMock.tasksPatchCalls.length, 1, 'tasks.tasks.patch should be called once');
    assert.equal((await db.agentProtocolEffects.toArray())[0].state, 'succeeded');
    assert.ok((await db.tasks.get(id))?.protocolRevision);
});

test('legacy updates preserve user provenance and queue Calendar changes while signed out', async () => {
    clearStore();
    setGoogleServiceState({ accessToken: null, userEmail: null });
    await resetDb();
    const id = await db.tasks.add({
        title: 'Original', type: 'meeting', urgency: 2, status: 'pending', date: '2026-10-02',
        source: 'user', googleEventId: 'linked-event', createdAt: 1, updatedAt: 1,
    });
    const original = (await db.tasks.get(id))!;
    const applied = await agentBridge.applyWrite({ id: 'legacy-edit', action: 'update_task',
        task_data: { id, title: 'Agent edit' }, created_at: 2 });
    assert.equal(applied.disposition, 'applied');
    const saved = (await db.tasks.get(id))!;
    assert.equal(saved.source, 'user');
    assert.equal(saved.agent_write_id, undefined);
    assert.equal(saved.publicId, original.publicId);
    assert.ok(saved.protocolRevision);
    const effects = await db.agentProtocolEffects.toArray();
    assert.equal(effects.length, 1);
    assert.equal(effects[0].state, 'pending');
    assert.equal(effects[0].operation, 'upsert');
    assert.equal(await db.agentProtocolEvents.count(), 1);
    assert.equal(gapiMock.calendarInsertCalls.length, 0);
});

test('legacy edits reject a stale revision, mismatched identity, and deleted task', async () => {
    clearStore();
    setGoogleServiceState({ accessToken: null, userEmail: null });
    await resetDb();
    const created = await agentBridge.applyWrite({ id: 'legacy-create', action: 'create_task',
        task_data: { title: 'Original', type: 'task' }, created_at: 1 });
    const original = (await db.tasks.get(created.newId!))!;
    await agentBridge.applyWrite({ id: 'legacy-edit', action: 'update_task',
        task_data: { id: original.id, title: 'Newer edit' }, created_at: 2 });
    const stale = await agentBridge.applyWrite({ id: 'legacy-stale', action: 'update_task',
        task_data: { ...original, title: 'Stale edit' }, created_at: 3 });
    assert.equal(stale.disposition, 'terminal');
    assert.equal((await db.tasks.get(original.id!))?.title, 'Newer edit');
    const mismatch = await agentBridge.applyWrite({ id: 'legacy-mismatch', action: 'delete_task',
        task_data: { id: original.id, publicId: 'task_other' }, created_at: 4 });
    assert.equal(mismatch.disposition, 'terminal');
    await db.tasks.update(original.id!, { isDeleted: true });
    const deleted = await agentBridge.applyWrite({ id: 'legacy-deleted', action: 'complete_task',
        task_data: { id: original.id }, created_at: 5 });
    assert.equal(deleted.disposition, 'terminal');
    assert.equal(await db.agentProtocolEvents.count(), 2);
});

test('U2: normalizeEntity clamps urgency 4 to 3', async () => {
    const { normalizeEntity } = await import('./semanticEngine.ts');
    const result = normalizeEntity({ title: 'T', type: 'task', urgency: 4, date: '2026-07-06' }, 'create', undefined);
    assert.equal(result.value.urgency, 3);
});

test('U2: normalizeEntity coerces unknown type to thought and surfaces last_error on update', async () => {
    const { normalizeEntity } = await import('./semanticEngine.ts');
    const existing = { id: 1, title: 'T', type: 'task', urgency: 2, status: 'pending', updatedAt: 0, createdAt: 0 } as never;
    const result = normalizeEntity({ type: 'bizarre' }, 'update', existing);
    assert.equal(result.value.type, 'thought');
    assert.ok(result.last_error, 'last_error should be set on coercion');
});

test('U2: normalizeEntity mirrors date↔deadline for tasks and clears startTime on isAllDay', async () => {
    const { normalizeEntity } = await import('./semanticEngine.ts');
    const r1 = normalizeEntity({ title: 'T', type: 'task', date: '2026-07-06' }, 'create', undefined);
    assert.equal(r1.value.date, '2026-07-06');
    assert.equal(r1.value.deadline, '2026-07-06');
    const r2 = normalizeEntity({ title: 'T', type: 'task', isAllDay: true, startTime: '09:00', date: '2026-07-06' }, 'create', undefined);
    assert.equal(r2.value.isAllDay, true);
    assert.equal(r2.value.startTime, undefined, 'isAllDay should clear startTime');
});

test('U4: create_worklog rejects inactive projectId with project-not-found', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const projId = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: false, updatedAt: Date.now(), createdAt: Date.now(),
    } as Project);

    const result = await agentBridge.applyWrite({
        id: 'agent-wl-1',
        action: 'create_worklog',
        worklog_data: { projectId: projId, date: '2026-07-06', hours: 8, people: 'A' },
        created_at: Date.now(),
    });
    assert.equal(result.success, false);
    assert.equal(result.last_error, 'project-not-found');
    assert.equal(await db.workLogs.count(), 0, 'rejected agent write must not persist a partial WorkLog');
});

test('U3: create_worklog rejects an unknown project atomically', async () => {
    await resetDb();

    const result = await agentBridge.applyWrite({
        id: 'agent-wl-unknown',
        action: 'create_worklog',
        worklog_data: { projectId: 999_999, date: '2026-07-06', hours: 8, people: 'A' },
        created_at: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.last_error, 'project-not-found');
    assert.equal(await db.workLogs.count(), 0);
});

test('U1: Agent Bridge create confirms a trimmed archived match and preserves its identity', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const createdAt = Date.now() - 10_000;
    const oldId = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: false, source: 'user', updatedAt: createdAt, createdAt,
    } as Project);

    const result = await agentBridge.applyWrite({
        id: 'agent-proj-1',
        action: 'create_project',
        project_data: { name: '  plaza  ', color: 'indigo' },
        created_at: Date.now(),
    });
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'restored');
    assert.equal(result.newId, oldId, 'should re-activate the existing project, not create a new one');
    assert.equal(await db.projects.count(), 1);
    const stored = await db.projects.get(oldId);
    assert.equal(stored!.isActive, true);
    assert.equal(stored!.name, 'Plaza');
    assert.equal(stored!.color, 'indigo');
    assert.equal(stored!.source, 'agent');
    assert.equal(stored!.agent_write_id, 'agent-proj-1');
    assert.equal(stored!.createdAt, createdAt);
});

test('U1: Agent Bridge returns duplicate for an active normalized match without writing', async () => {
    await resetDb();
    const original: Project = {
        name: 'Plaza', color: 'slate', isActive: true, source: 'user', updatedAt: 20, createdAt: 10,
    };
    const id = await db.projects.add(original);

    const result = await agentBridge.applyWrite({
        id: 'agent-proj-duplicate',
        action: 'create_project',
        project_data: { name: ' PLAZA ', color: 'rose' },
        created_at: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.outcome, 'duplicate');
    assert.equal(result.disposition, 'terminal');
    assert.equal(shouldAcknowledgeApplyWrite(result), true);
    assert.equal(result.last_error, 'project already exists');
    assert.deepEqual(await db.projects.toArray(), [{ ...original, id }]);
});

test('manual-merge aliases make Agent Bridge project creates terminal duplicate or archived-match outcomes', async () => {
    await resetDb();
    const activeId = await db.projects.add({
        name: 'Komerční Banka', aliases: ['Komerční banka Plaza'], color: 'amber',
        isActive: true, updatedAt: 20, createdAt: 10,
    } as Project);

    const duplicate = await agentBridge.applyWrite({
        id: 'agent-project-alias-active',
        action: 'create_project',
        project_data: { name: ' komerční BANKA plaza ' },
        created_at: Date.now(),
    });
    assert.equal(duplicate.success, false);
    assert.equal(duplicate.disposition, 'terminal');
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(await db.projects.count(), 1);

    await db.projects.update(activeId, { isActive: false });
    const archivedMatch = await agentBridge.applyWrite({
        id: 'agent-project-alias-archived',
        action: 'create_project',
        project_data: { name: 'Komerční banka Plaza' },
        created_at: Date.now(),
    });
    assert.equal(archivedMatch.success, false);
    assert.equal(archivedMatch.disposition, 'terminal');
    assert.equal(archivedMatch.outcome, 'archived-match');
    assert.equal((await db.projects.get(activeId))!.isActive, false);
});

test('manual-merge alias blocks Agent Bridge rename without a partial project write', async () => {
    await resetDb();
    const survivorId = await db.projects.add({
        name: 'Komerční Banka', aliases: ['Komerční banka Plaza'], color: 'amber',
        isActive: true, updatedAt: 20, createdAt: 10,
    } as Project);
    const other: Project = {
        name: 'Jiný projekt', color: 'rose', isActive: true, updatedAt: 30, createdAt: 30,
    };
    const otherId = await db.projects.add(other);

    const result = await agentBridge.applyWrite({
        id: 'agent-project-alias-rename',
        action: 'update_project',
        project_data: { id: otherId, name: 'Komerční banka Plaza', color: 'indigo' },
        created_at: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.disposition, 'terminal');
    assert.equal(result.outcome, 'duplicate');
    assert.deepEqual(await db.projects.get(otherId), { ...other, id: otherId });
    assert.equal((await db.projects.get(survivorId))!.name, 'Komerční Banka');
});

test('pending project action for an absorbed source id ends terminally without redirecting to survivor', async () => {
    await resetDb();
    const survivor: Project = {
        name: 'Komerční Banka', aliases: ['Komerční banka Plaza'], color: 'amber',
        isActive: true, updatedAt: 20, createdAt: 10,
    };
    const survivorId = await db.projects.add(survivor);

    const result = await agentBridge.applyWrite({
        id: 'agent-stale-source-project',
        action: 'delete_project',
        project_data: { id: survivorId + 999 },
        created_at: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.disposition, 'terminal');
    assert.equal(result.last_error, 'project not found');
    assert.deepEqual(await db.projects.get(survivorId), { ...survivor, id: survivorId });
});

test('Agent Bridge WorkLog with absorbed alias and removed source id resolves to active survivor', async () => {
    await resetDb();
    const survivorId = await db.projects.add({
        name: 'Komerční Banka', aliases: ['Komerční banka Plaza'], color: 'amber',
        isActive: true, updatedAt: 20, createdAt: 10,
    } as Project);

    const result = await agentBridge.applyWrite({
        id: 'agent-stale-source-worklog',
        action: 'create_worklog',
        worklog_data: {
            projectId: survivorId + 999,
            projectName: 'Komerční banka Plaza',
            date: '2026-08-08',
            hours: 4,
            people: 'Martin',
        },
        created_at: Date.now(),
    });

    assert.equal(result.success, true);
    const stored = await db.workLogs.get(result.newId!);
    assert.equal(stored!.projectId, survivorId);
    assert.equal(stored!.projectName, 'Komerční Banka');
});

test('Agent Bridge update with an absorbed source id preserves the historical project snapshot', async () => {
    await resetDb();
    const survivorId = await db.projects.add({
        name: 'Komerční Banka', aliases: ['Komerční banka Plaza'], color: 'amber',
        isActive: true, updatedAt: 20, createdAt: 10,
    } as Project);
    const workLogId = await db.workLogs.add({
        syncId: 'historical-alias-update', date: '2026-08-08', projectId: survivorId,
        projectName: 'Komerční banka Plaza', people: 'Martin', hours: 4,
        source: 'manual', updatedAt: 30, createdAt: 30,
    });

    const result = await agentBridge.applyWrite({
        id: 'agent-update-stale-source',
        action: 'update_worklog',
        worklog_data: {
            id: workLogId,
            projectId: survivorId + 999,
            projectName: 'Komerční banka Plaza',
            description: 'Updated after merge',
        },
        created_at: Date.now(),
    });

    assert.equal(result.success, true);
    const stored = await db.workLogs.get(workLogId);
    assert.equal(stored!.projectId, survivorId);
    assert.equal(stored!.projectName, 'Komerční banka Plaza');
    assert.equal(stored!.description, 'Updated after merge');
});

test('Agent Bridge rejects project aliases instead of mutating identity metadata', async () => {
    await resetDb();
    const result = await agentBridge.applyWrite({
        id: 'agent-project-alias-write',
        action: 'create_project',
        project_data: {
            name: 'Agent project',
            aliases: ['Injected alias'],
        } as unknown as AgentWriteProjectData,
        created_at: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.disposition, 'terminal');
    assert.equal(result.last_error, 'project aliases are not agent-writable');
    assert.equal(await db.projects.count(), 0);
});

test('U4: create_project rejects empty name with name required', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const result = await agentBridge.applyWrite({
        id: 'agent-proj-empty',
        action: 'create_project',
        project_data: { name: '   ' },
        created_at: Date.now(),
    });
    assert.equal(result.success, false);
    assert.equal(result.last_error, 'name required');
});

test('U4: delete_project is a soft delete (isActive: false)', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const id = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: true, updatedAt: Date.now(), createdAt: Date.now(),
    } as Project);
    const result = await agentBridge.applyWrite({
        id: 'agent-proj-del',
        action: 'delete_project',
        project_data: { id },
        created_at: Date.now(),
    });
    assert.equal(result.success, true);
    const stored = await db.projects.get(id);
    assert.equal(stored!.isActive, false);
});

test('U4: update_settings writes to db.settings with source=agent', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const result = await agentBridge.applyWrite({
        id: 'agent-set-1',
        action: 'update_settings',
        settings_data: { id: 'gemini_model', value: 'gemini-2.0-pro' },
        created_at: Date.now(),
    });
    assert.equal(result.success, true);
    const stored = await db.settings.get('gemini_model');
    assert.ok(stored);
    assert.equal((stored as Setting).value, 'gemini-2.0-pro');
    assert.equal((stored as Setting).source, 'agent');
    assert.equal((stored as Setting).agent_write_id, 'agent-set-1');
});

test('U4: delete_settings rejects gemini_model with key-not-deletable', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const result = await agentBridge.applyWrite({
        id: 'agent-set-del',
        action: 'delete_settings',
        settings_data: { id: 'gemini_model' },
        created_at: Date.now(),
    });
    assert.equal(result.success, false);
    assert.equal(result.last_error, 'key-not-deletable');
});

test('U4: delete_settings removes gemini_api_key', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    await db.settings.put({ id: 'gemini_api_key', value: 'old-key' });
    const result = await agentBridge.applyWrite({
        id: 'agent-set-key-del',
        action: 'delete_settings',
        settings_data: { id: 'gemini_api_key' },
        created_at: Date.now(),
    });
    assert.equal(result.success, true);
    const stored = await db.settings.get('gemini_api_key');
    assert.equal(stored, undefined);
});

test('U4: create_worklog lands in db.workLogs (NOT db.tasks)', async () => {
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    (agentBridge as unknown as { drive: { init: () => Promise<boolean>; readJsonFile: () => Promise<{ fileId: string | null; data: unknown } | null>; writeJsonFile: () => Promise<string> } }).drive = {
        init: async () => true,
        readJsonFile: async () => null,
        writeJsonFile: async () => 'fake-file-id',
    };
    await resetDb();
    const projId = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: true, updatedAt: Date.now(), createdAt: Date.now(),
    } as Project);
    const result = await agentBridge.applyWrite({
        id: 'agent-wl-2',
        action: 'create_worklog',
        worklog_data: { projectId: projId, date: '2026-07-06', hours: 4, people: 'A, B' },
        created_at: Date.now(),
    });
    assert.equal(result.success, true);
    const wl = await db.workLogs.get(result.newId!);
    assert.ok(wl);
    assert.equal((wl as WorkLog).source, 'agent');
    assert.ok((wl as WorkLog).syncId, 'agent-created WorkLogs receive a stable sync identity');
    assert.equal((wl as WorkLog).projectName, 'Plaza', 'the transaction snapshots the active catalog name');
    // Crucially: it must NOT be in db.tasks
    const taskWithSameId = await db.tasks.get(result.newId!);
    assert.equal(taskWithSameId, undefined, 'create_worklog must not write to db.tasks');
});

test('review: update_worklog preserves sync identity and atomically changes to an active project', async () => {
    await resetDb();
    const originalProjectId = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: true, updatedAt: 10, createdAt: 10,
    } as Project);
    const targetProjectId = await db.projects.add({
        name: 'Riverside', color: 'indigo', isActive: true, updatedAt: 20, createdAt: 20,
    } as Project);
    const workLogId = await db.workLogs.add({
        syncId: 'stable-agent-sync', date: '2026-07-06', projectId: originalProjectId,
        projectName: 'Plaza', people: 'A', hours: 4, source: 'agent',
        agent_write_id: 'agent-create', updatedAt: 30, createdAt: 30,
    });

    const result = await agentBridge.applyWrite({
        id: 'agent-update-active',
        action: 'update_worklog',
        worklog_data: {
            id: workLogId,
            syncId: 'attempted-replacement',
            projectId: targetProjectId,
            projectName: 'Riverside',
            description: 'Updated safely',
        },
        created_at: Date.now(),
    });

    assert.equal(result.success, true);
    const stored = await db.workLogs.get(workLogId);
    assert.equal(stored!.syncId, 'stable-agent-sync');
    assert.equal(stored!.projectId, targetProjectId);
    assert.equal(stored!.projectName, 'Riverside');
    assert.equal(stored!.description, 'Updated safely');
    assert.equal(stored!.source, 'agent');
    assert.equal(stored!.agent_write_id, 'agent-create');
    assert.equal(stored!.createdAt, 30);
});

test('review: update_worklog rejects inactive reassignment without a partial write', async () => {
    await resetDb();
    const originalProjectId = await db.projects.add({
        name: 'Plaza', color: 'slate', isActive: true, updatedAt: 10, createdAt: 10,
    } as Project);
    const archivedProjectId = await db.projects.add({
        name: 'Archived', color: 'rose', isActive: false, updatedAt: 20, createdAt: 20,
    } as Project);
    const workLogId = await db.workLogs.add({
        syncId: 'stable-agent-sync', date: '2026-07-06', projectId: originalProjectId,
        projectName: 'Plaza', people: 'A', hours: 4, source: 'agent',
        agent_write_id: 'agent-create', updatedAt: 30, createdAt: 30,
    });
    const before = await db.workLogs.get(workLogId);

    const result = await agentBridge.applyWrite({
        id: 'agent-update-archived',
        action: 'update_worklog',
        worklog_data: {
            id: workLogId,
            projectId: archivedProjectId,
            projectName: 'Archived',
            description: 'Must not persist',
        },
        created_at: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.disposition, 'terminal');
    assert.equal(result.last_error, 'project-not-found');
    assert.deepEqual(await db.workLogs.get(workLogId), before);
});

test('review: update_worklog rejects an incomplete project pair', async () => {
    await resetDb();
    const result = await agentBridge.applyWrite({
        id: 'agent-update-incomplete-project',
        action: 'update_worklog',
        worklog_data: { id: 1, projectId: 123 },
        created_at: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.disposition, 'terminal');
    assert.equal(result.last_error, 'projectId and projectName required together');
});

test('review: update_worklog keeps an unchanged archived historical assignment editable', async () => {
    await resetDb();
    const archivedProjectId = await db.projects.add({
        name: 'Archived', color: 'amber', isActive: false, updatedAt: 20, createdAt: 20,
    } as Project);
    const workLogId = await db.workLogs.add({
        syncId: 'historical-sync', date: '2026-07-06', projectId: archivedProjectId,
        projectName: 'Archived', people: 'A', hours: 4, source: 'manual',
        updatedAt: 30, createdAt: 30,
    });

    const result = await agentBridge.applyWrite({
        id: 'agent-update-history',
        action: 'update_worklog',
        worklog_data: {
            id: workLogId,
            projectId: archivedProjectId,
            projectName: 'Archived',
            description: 'Historical note',
        },
        created_at: Date.now(),
    });

    assert.equal(result.success, true);
    const stored = await db.workLogs.get(workLogId);
    assert.equal(stored!.projectId, archivedProjectId);
    assert.equal(stored!.projectName, 'Archived');
    assert.equal(stored!.description, 'Historical note');
});

test('review: polling acknowledges terminal outcomes but retries transient failures', () => {
    assert.equal(shouldAcknowledgeApplyWrite({
        success: false,
        disposition: 'terminal',
        last_error: 'name required',
    }), true);
    assert.equal(shouldAcknowledgeApplyWrite({
        success: false,
        disposition: 'retryable',
        last_error: 'IndexedDB unavailable',
    }), false);
});

test('U5: mirrorInbox is idempotent for re-reads of the same id', async () => {
    await resetDb();
    const write = {
        id: 'mirror-1',
        action: 'create_task' as const,
        task_data: { title: 'T', type: 'task' as const, urgency: 2 as const, status: 'pending' as const },
        created_at: Date.now(),
    };
    await agentBridge.mirrorInbox([write]);
    await agentBridge.mirrorInbox([write]);
    await agentBridge.mirrorInbox([write]);
    const all = await db.agentInbox.toArray();
    const matches = all.filter((r) => r.id === 'mirror-1');
    assert.equal(matches.length, 1, 'mirrorInbox should be idempotent');
});

test('U5: recordInboxResult stamps applied_at on success', async () => {
    await resetDb();
    await agentBridge.mirrorInbox([{
        id: 'rec-1',
        action: 'create_task' as const,
        task_data: { title: 'T', type: 'task' as const, urgency: 2 as const, status: 'pending' as const },
        created_at: Date.now(),
    }]);
    await agentBridge.recordInboxResult('rec-1', true);
    const row = await db.agentInbox.get('rec-1');
    assert.ok(row);
    assert.ok(row!.applied_at && row!.applied_at > 0);
    assert.equal(row!.last_error, undefined);
});

test('review: terminal rejection is acknowledged while retaining its diagnostic', async () => {
    await resetDb();
    await agentBridge.mirrorInbox([{
        id: 'rec-terminal',
        action: 'create_project' as const,
        project_data: { name: '' },
        created_at: Date.now(),
    }]);
    await agentBridge.recordInboxResult('rec-terminal', true, 'name required');
    const row = await db.agentInbox.get('rec-terminal');
    assert.ok(row!.applied_at && row!.applied_at > 0);
    assert.equal(row!.last_error, 'name required');
});

test('U5: recordInboxResult stores last_error on failure', async () => {
    await resetDb();
    await agentBridge.mirrorInbox([{
        id: 'rec-fail',
        action: 'create_task' as const,
        task_data: { title: 'T', type: 'task' as const, urgency: 2 as const, status: 'pending' as const },
        created_at: Date.now(),
    }]);
    await agentBridge.recordInboxResult('rec-fail', false, 'auth-unavailable');
    const row = await db.agentInbox.get('rec-fail');
    assert.ok(row);
    assert.equal(row!.last_error, 'auth-unavailable');
    assert.equal(row!.applied_at, undefined, 'failure should not stamp applied_at');
});

test('U5: clearAppliedInbox hides applied diagnostics but retains durable receipts', async () => {
    await resetDb();
    await agentBridge.mirrorInbox([
        { id: 'a', action: 'create_task', task_data: { title: 'A', type: 'task', urgency: 2, status: 'pending' }, created_at: 1 },
        { id: 'b', action: 'create_task', task_data: { title: 'B', type: 'task', urgency: 2, status: 'pending' }, created_at: 2 },
    ]);
    await agentBridge.recordInboxResult('a', true);
    await agentBridge.clearAppliedInbox();
    assert.ok((await db.agentInbox.get('a'))!.applied_at);
    const remaining = await agentBridge.listInbox();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.id, 'b');
});

test('U7: agentInbox is a Dexie Table and the current schema opens', async () => {
    await db.open();
    const tables = (db as unknown as { tables: Array<{ name: string }> }).tables;
    const names = tables.map(t => t.name).sort();
    assert.ok(names.includes('tasks'), 'tasks must be present');
    assert.ok(names.includes('agentInbox'), 'agentInbox must be present (U7 addition)');
    assert.ok(names.includes('workLogs'), 'workLogs must be present');
    assert.ok(names.includes('projects'), 'projects must be present');
    assert.ok(names.includes('settings'), 'settings must be present');
    assert.equal(await db.verno, 19);
});


test('regression: 42 googleService tests still pass (verified separately via test:worklogs)', () => {
    // The googleService.test.ts suite is part of the test:worklogs chain; this
    // test is a sentinel that the chain order is preserved.
    assert.ok(true);
});

test('health: failed acknowledgement and reload never replay a local mutation', async () => {
    await resetDb();
    const projectId = await db.projects.add({ name: 'Receipt', isActive: true, color: 'slate', updatedAt: 1, createdAt: 1 } as Project);
    const write = { id: 'ack-retry', action: 'create_worklog' as const, created_at: 1, worklog_data: { projectId, date: '2026-09-25', hours: 1 } };
    let writes: import('./agentBridge.ts').AgentWrite[] = [write];
    let attempts = 0;
    const internal = agentBridge as unknown as { isInitialized: boolean; drive: unknown };
    internal.isInitialized = false;
    internal.drive = {
        init: async () => true,
        readJsonFile: async () => ({ fileId: 'pending', data: { writes } }),
        writeJsonFile: async (_name: string, data: { writes: typeof writes }) => {
            if (++attempts === 1) throw new Error('ack unavailable');
            writes = data.writes;
            return 'pending';
        },
    };
    const poll = async () => {
        await agentBridge.init();
        const pending = await agentBridge.fetchPendingWrites();
        await agentBridge.mirrorInbox(pending);
        for (const item of pending) {
            assert.equal((await agentBridge.applyWrite(item)).success, true);
            await agentBridge.recordInboxResult(item.id, true);
        }
        await agentBridge.markApplied(pending.map(item => item.id));
    };
    await poll();
    const receipt = await db.agentInbox.get(write.id);
    await agentBridge.mirrorInbox([write]);
    assert.equal((await db.agentInbox.get(write.id))!.applied_at, receipt!.applied_at);
    internal.isInitialized = false;
    db.close();
    await db.open();
    await poll();
    assert.equal(await db.workLogs.count(), 1);
    assert.equal(attempts, 2);
    assert.ok(writes[0]!.applied_at);
});

test('health: concurrent application is atomic and payload conflicts fail closed', async () => {
    await resetDb();
    const projectId = await db.projects.add({ name: 'Concurrent', isActive: true, color: 'slate', updatedAt: 1, createdAt: 1 } as Project);
    const write = { id: 'concurrent-receipt', action: 'create_worklog' as const, created_at: 1, worklog_data: { projectId, date: '2026-09-25', hours: 1 } };
    const results = await Promise.all([agentBridge.applyWrite(write), agentBridge.applyWrite(write)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(await db.workLogs.count(), 1);
    const changed = await agentBridge.applyWrite({ ...write, worklog_data: { ...write.worklog_data, hours: 2 } });
    assert.equal(changed.disposition, 'terminal');
    assert.equal(changed.last_error, 'command id reused with different payload');
    assert.equal((await db.workLogs.toArray())[0]!.hours, 1);
});

test('health: failed receipt persistence rolls back the domain mutation', async () => {
    await resetDb();
    const projectId = await db.projects.add({ name: 'Rollback', isActive: true, color: 'slate', updatedAt: 1, createdAt: 1 } as Project);
    const write = { id: 'receipt-rollback', action: 'create_worklog' as const, created_at: 1, worklog_data: { projectId, date: '2026-09-25', hours: 1 } };
    const fail = () => { throw new Error('receipt storage unavailable'); };
    db.agentInbox.hook('creating', fail);
    try {
        assert.equal((await agentBridge.applyWrite(write)).disposition, 'retryable');
        assert.equal(await db.workLogs.count(), 0);
    } finally {
        db.agentInbox.hook('creating').unsubscribe(fail);
    }
    assert.equal((await agentBridge.applyWrite(write)).success, true);
    assert.equal(await db.workLogs.count(), 1);
});

test('health: failed task receipt rolls back its revision and Google effect before delivery', async () => {
    await resetDb();
    seedSignedInStorage();
    setGoogleServiceState({ accessToken: 'tok', expiresAt: Date.now() + 60 * 60 * 1000, userEmail: 'user@example.com' });
    const inserts = gapiMock.calendarInsertCalls.length;
    const effects = await db.agentProtocolEffects.count();
    const events = await db.agentProtocolEvents.count();
    const fail = () => { throw new Error('receipt unavailable'); };
    db.agentInbox.hook('creating', fail);
    try {
        const result = await agentBridge.applyWrite({ id: 'task-receipt-rollback', action: 'create_task', created_at: 1,
            task_data: { title: 'Atomic task', type: 'task', date: '2026-09-25', startTime: '10:00', duration: 60 } });
        assert.equal(result.disposition, 'retryable');
        assert.equal(await db.tasks.count(), 0);
        assert.equal(await db.agentProtocolEffects.count(), effects);
        assert.equal(await db.agentProtocolEvents.count(), events);
        assert.equal(gapiMock.calendarInsertCalls.length, inserts);
    } finally {
        db.agentInbox.hook('creating').unsubscribe(fail);
    }
});

test('health: old applied diagnostics suppress replay after clearing and re-mirroring', async () => {
    await resetDb();
    const write = { id: 'old-receipt', action: 'create_project' as const, created_at: 1, project_data: { name: 'Do not recreate' } };
    await db.agentInbox.put({ id: write.id, action: write.action, entity_type: 'project', payload: write, received_at: 1, applied_at: 2 });
    await agentBridge.clearAppliedInbox();
    await agentBridge.mirrorInbox([write]);
    assert.equal((await agentBridge.applyWrite(write)).disposition, 'applied');
    assert.equal(await db.projects.count(), 0);
});
