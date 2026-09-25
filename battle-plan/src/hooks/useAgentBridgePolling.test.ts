/// <reference types="node" />
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';
import type { createAgentBridgePoller as CreatePoller } from './useAgentBridgePolling.ts';
import type { AgentWrite, ApplyWriteResult } from '../services/agentBridge.ts';

const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); }, clear: () => { storage.clear(); },
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
};
const vite = await createServer({ configFile: false, root: process.cwd(), optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' });
after(async () => vite.close());
const { createAgentBridgePoller } = await vite.ssrLoadModule('/src/hooks/useAgentBridgePolling.ts') as { createAgentBridgePoller: typeof CreatePoller };

test('real bridge retries failed acknowledgement after reload and diagnostics clear without duplicating work', async () => {
    const { agentBridge } = await vite.ssrLoadModule('/src/services/agentBridge.ts') as typeof import('../services/agentBridge.ts');
    const { db } = await vite.ssrLoadModule('/src/db.ts') as typeof import('../db.ts');
    await db.agentInbox.clear();
    await db.workLogs.clear();
    await db.projects.clear();
    const projectId = await db.projects.add({ name: 'Polling', color: 'slate', isActive: true, createdAt: 1, updatedAt: 1 });
    let writes: AgentWrite[] = [{ id: 'poll-ack-retry', action: 'create_worklog', created_at: 1, worklog_data: { projectId, date: '2026-09-25', hours: 2 } }];
    let acknowledgements = 0;
    const internal = agentBridge as unknown as { drive: unknown; isInitialized: boolean };
    internal.isInitialized = false;
    internal.drive = {
        init: async () => true,
        readJsonFile: async () => ({ fileId: 'legacy-inbox', data: { writes } }),
        writeJsonFile: async (_name: string, data: { writes: AgentWrite[] }) => {
            if (++acknowledgements === 1) throw new Error('simulated Drive outage');
            writes = data.writes;
            return 'legacy-inbox';
        },
    };
    const first = createAgentBridgePoller(agentBridge, () => undefined);
    await first.poll();
    first.stop();
    assert.equal(await db.workLogs.count(), 1);
    await agentBridge.clearAppliedInbox();
    assert.equal((await agentBridge.listInbox()).length, 0);
    db.close();
    await db.open();
    internal.isInitialized = false;
    const reloaded = createAgentBridgePoller(agentBridge, () => undefined);
    await reloaded.poll();
    reloaded.stop();
    assert.equal(await db.workLogs.count(), 1);
    assert.equal(acknowledgements, 2);
    assert.ok(writes[0]!.applied_at);
});

const write: AgentWrite = { id: 'write-1', action: 'create_task', created_at: 1, task_data: { title: 'Once' } };
function fakeBridge() {
    const applied: string[] = [];
    const recorded: Array<[string, boolean]> = [];
    const acknowledged: string[][] = [];
    return {
        initialized: true,
        init: async () => undefined,
        fetchPendingWrites: async () => [write],
        mirrorInbox: async () => undefined,
        applyWrite: async (input: AgentWrite): Promise<ApplyWriteResult> => { applied.push(input.id); return { success: true, disposition: 'applied' }; },
        recordInboxResult: async (id: string, success: boolean) => { recorded.push([id, success]); },
        markApplied: async (ids: string[]) => { acknowledged.push(ids); },
        applied, recorded, acknowledged,
    };
}

test('overlapping interval, visibility and focus polls share the complete fetch/apply/ack pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bridge = fakeBridge();
    let fetches = 0;
    bridge.fetchPendingWrites = async () => { fetches++; await gate; return [write]; };
    const poller = createAgentBridgePoller(bridge, () => undefined);
    const passes = [poller.poll(), poller.poll(), poller.poll()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetches, 1);
    release();
    await Promise.all(passes);
    assert.deepEqual(bridge.applied, ['write-1']);
    assert.deepEqual(bridge.acknowledged, [['write-1']]);
    poller.stop();
});

test('failed pass can retry and only applied/terminal outcomes are acknowledged', async () => {
    const bridge = fakeBridge();
    let fetches = 0;
    bridge.fetchPendingWrites = async () => {
        if (++fetches === 1) throw new Error('transient read failure');
        return [write, { ...write, id: 'invalid' }, { ...write, id: 'retry' }];
    };
    bridge.applyWrite = async (input) => input.id === 'write-1'
        ? { success: true, disposition: 'applied' }
        : { success: false, disposition: input.id === 'invalid' ? 'terminal' : 'retryable' };
    const poller = createAgentBridgePoller(bridge, () => undefined);
    await poller.poll();
    await poller.poll();
    assert.equal(fetches, 2);
    assert.deepEqual(bridge.acknowledged, [['write-1', 'invalid']]);
    assert.deepEqual(bridge.recorded, [['write-1', true], ['invalid', true], ['retry', false]]);
    poller.stop();
});

test('teardown during a read prevents mutations and stale logs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bridge = fakeBridge();
    bridge.fetchPendingWrites = async () => { await gate; return [write]; };
    const logs: string[] = [];
    const poller = createAgentBridgePoller(bridge, (message) => { logs.push(message); });
    const pending = poller.poll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    poller.stop();
    release();
    await pending;
    await poller.poll();
    assert.deepEqual(bridge.applied, []);
    assert.deepEqual(logs, []);
});
