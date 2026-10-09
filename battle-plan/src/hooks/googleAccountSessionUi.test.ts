/// <reference types="node" />
import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { createServer } from 'vite';
import type { AgentSuggestion } from '../services/suggestionsSync.ts';
import type { GoogleAuthStatus } from '../types.ts';

const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  },
  window: { addEventListener: () => {}, removeEventListener: () => {} },
});

// Exercise the real hook/page callbacks with deterministic effects and state.
// Only React's scheduling boundary is substituted; services are mocked per test.
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
const equalDeps = (a?: readonly unknown[], b?: readonly unknown[]) =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
class HookHarness {
  private slots: Slot[] = [];
  private cursor = 0;
  private effects: Array<() => void> = [];
  private slot() { return this.slots[this.cursor++] ?? (this.slots[this.cursor - 1] = {}); }
  useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] {
    const slot = this.slot();
    if (!('value' in slot)) slot.value = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [slot.value as T, value => {
      slot.value = typeof value === 'function' ? (value as (previous: T) => T)(slot.value as T) : value;
    }];
  }
  useRef<T>(initial: T) {
    const slot = this.slot();
    if (!('value' in slot)) slot.value = { current: initial };
    return slot.value as { current: T };
  }
  useMemo<T>(factory: () => T, deps?: readonly unknown[]) {
    const slot = this.slot();
    if (!equalDeps(slot.deps, deps)) { slot.value = factory(); slot.deps = deps; }
    return slot.value as T;
  }
  useCallback<T>(callback: T, deps?: readonly unknown[]) { return this.useMemo(() => callback, deps); }
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
    const slot = this.slot();
    if (equalDeps(slot.deps, deps)) return;
    slot.deps = deps;
    this.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; });
  }
  render<T>(callback: () => T) {
    this.cursor = 0;
    (globalThis as unknown as { __uiHooks: HookHarness }).__uiHooks = this;
    const output = callback();
    const effects = this.effects.splice(0);
    effects.forEach(effect => effect());
    return output;
  }
  stop() { this.slots.forEach(slot => slot.cleanup?.()); }
}

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  plugins: [{
    name: 'account-session-ui-hooks',
    enforce: 'pre',
    transform(source, id) {
      if (/(?:useDriveSyncOrchestration|useSuggestionsBadge|useAgentBridgePolling|SuggestionsPage)\.(?:ts|tsx)$/.test(id)) {
        return source.replace("from 'react'", "from 'account-session-ui-hooks'");
      }
    },
    resolveId(source) { return source === 'account-session-ui-hooks' ? '\0account-session-ui-hooks' : undefined; },
    load(id) {
      if (id !== '\0account-session-ui-hooks') return;
      return ['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect']
        .map(name => `export const ${name} = (...args) => globalThis.__uiHooks.${name}(...args);`).join('\n');
    },
  }],
});
after(async () => vite.close());
const { googleService } = await vite.ssrLoadModule('/src/services/googleService.ts') as typeof import('../services/googleService.ts');
const { suggestionsSync } = await vite.ssrLoadModule('/src/services/suggestionsSync.ts') as typeof import('../services/suggestionsSync.ts');
const { suggestionRegistry } = await vite.ssrLoadModule('/src/services/suggestionRegistry.ts') as typeof import('../services/suggestionRegistry.ts');
const { suggestionRegistrySync } = await vite.ssrLoadModule('/src/services/suggestionRegistrySync.ts') as typeof import('../services/suggestionRegistrySync.ts');
const { SuggestionsPage } = await vite.ssrLoadModule('/src/pages/SuggestionsPage.tsx') as typeof import('../pages/SuggestionsPage.tsx');
const { useSuggestionsBadge } = await vite.ssrLoadModule('/src/hooks/useSuggestionsBadge.ts') as typeof import('./useSuggestionsBadge.ts');
const { useDriveSyncOrchestration } = await vite.ssrLoadModule('/src/hooks/useDriveSyncOrchestration.ts') as typeof import('./useDriveSyncOrchestration.ts');
const { useAgentBridgePolling } = await vite.ssrLoadModule('/src/hooks/useAgentBridgePolling.ts') as typeof import('./useAgentBridgePolling.ts');
const { agentBridge } = await vite.ssrLoadModule('/src/services/agentBridge.ts') as typeof import('../services/agentBridge.ts');
const { taskDriveBackup } = await vite.ssrLoadModule('/src/services/taskDriveBackup.ts') as typeof import('../services/taskDriveBackup.ts');
const { db } = await vite.ssrLoadModule('/src/db.ts') as typeof import('../db.ts');

const suggestion: AgentSuggestion = {
  id: 'a-suggestion', created_at: 1, source: 'agent', category: 'task', title: 'Account A proposal', description: '',
  context: { related_task_ids: [], related_email_ids: [], deadline: null, priority: 'medium' },
  status: 'open', reply_count: 0, last_reply_at: null,
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; }); return { pending, finish }; }
function fixture(t: TestContext) {
  const auth = { account: 'a', generation: 1 };
  t.mock.method(googleService, 'getAccountId', () => auth.account);
  t.mock.method(googleService, 'getAuthGeneration', () => auth.generation);
  t.mock.method(googleService, 'getAuthStatus', () => ({ state: 'SIGNED_IN', accessToken: auth.account }));
  t.mock.method(suggestionsSync, 'init', async () => {});
  t.mock.getter(suggestionsSync, 'initialized', () => true);
  t.mock.method(suggestionsSync, 'fetchSuggestionsDetailed', async () => ({ kind: 'loaded', suggestions: [{ ...suggestion, id: `${auth.account}-suggestion` }] }));
  t.mock.method(suggestionsSync, 'fetchRepliesDetailed', async () => ({ kind: 'missing-file', replies: [] }));
  t.mock.method(suggestionRegistrySync, 'fetchAndMerge', async () => ({ kind: 'loaded' }));
  t.mock.method(suggestionRegistrySync, 'publishPending', async () => ({ kind: 'nothing-pending' }));
  t.mock.method(suggestionRegistry, 'ingestLegacy', async () => {});
  t.mock.method(suggestionRegistry, 'resolveMany', async (values: AgentSuggestion[]) => values.map(() => undefined));
  const harness = new HookHarness();
  t.after(() => harness.stop());
  const props = { googleAuth: { state: 'SIGNED_IN', accessToken: 'a' } as GoogleAuthStatus, onAddLog: () => {} };
  const renderPage = () => harness.render(() => SuggestionsPage(props));
  const switchAccount = () => { auth.account = 'b'; auth.generation++; props.googleAuth = { state: 'SIGNED_IN', accessToken: 'b' }; };
  return { auth, harness, props, renderPage, switchAccount };
}
function elements(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(elements);
  const props = (value as { props?: Record<string, unknown> }).props;
  if (!props) return [];
  return [props, ...elements(props.children)];
}
const cards = (value: unknown) => elements(value).filter(props => props.suggestion);

test('a new account can load while an old page read is pending, and the old result cannot replace it', async t => {
  const f = fixture(t); const wait = gate(); let reads = 0;
  t.mock.method(suggestionsSync, 'fetchSuggestionsDetailed', async () => {
    const account = f.auth.account; reads++;
    if (account === 'a') await wait.pending;
    return { kind: 'loaded', suggestions: [{ ...suggestion, id: `${account}-suggestion` }] };
  });
  f.renderPage(); await tick();
  f.switchAccount(); f.renderPage(); await tick();
  assert.equal(reads, 2);
  assert.equal((cards(f.renderPage())[0]?.suggestion as AgentSuggestion).id, 'b-suggestion');
  wait.finish(); await tick();
  assert.equal((cards(f.renderPage())[0]?.suggestion as AgentSuggestion).id, 'b-suggestion');
});

test('an old load completion cannot release the reservation of a still-pending new account load', async t => {
  const f = fixture(t); const waits = { a: gate(), b: gate() }; let reads = 0;
  t.mock.method(suggestionsSync, 'fetchSuggestionsDetailed', async () => {
    const account = f.auth.account as 'a' | 'b'; reads++;
    await waits[account].pending;
    return { kind: 'loaded', suggestions: [{ ...suggestion, id: `${account}-suggestion` }] };
  });
  f.renderPage(); await tick();
  f.switchAccount(); f.renderPage(); await tick();
  waits.a.finish(); await tick();
  const refresh = elements(f.renderPage()).find(props =>
    Array.isArray(props.children) && props.children.includes('Obnovit')
  )!;
  await (refresh.onClick as () => Promise<void>)();
  assert.equal(reads, 2);
  waits.b.finish(); await tick();
  assert.equal((cards(f.renderPage())[0]?.suggestion as AgentSuggestion).id, 'b-suggestion');
});

for (const phase of ['voice-upload', 'local-decision'] as const) {
  test(`account switch after ${phase} does not publish or mirror the old action in the new account`, async t => {
    const f = fixture(t); const wait = gate(); let mirrors = 0; let publications = 0;
    f.renderPage(); await tick(); const card = cards(f.renderPage())[0]!;
    t.mock.method(suggestionRegistrySync, 'publishPending', async () => { publications++; return { kind: 'nothing-pending' }; });
    t.mock.method(suggestionsSync, 'addReply', async () => { mirrors++; return { success: true, id: 'reply' }; });
    t.mock.method(suggestionsSync, 'updateSuggestionStatus', async () => { mirrors++; return { success: true }; });
    t.mock.method(suggestionRegistry, 'recordDecision', async () => { if (phase === 'local-decision') await wait.pending; });
    t.mock.method(suggestionsSync, 'uploadVoiceReply', async () => { await wait.pending; return { success: true, fileId: 'a-voice' }; });
    const pending = phase === 'voice-upload'
      ? (card.onVoiceReply as (blob: Blob) => Promise<void>)(new Blob(['audio']))
      : (card.onReject as () => Promise<void>)();
    await tick(); f.switchAccount(); wait.finish(); await pending;
    assert.equal(mirrors, 0); assert.equal(publications, 0);
  });
}

test('account change inside a real page decision rolls back its database rows', async t => {
  const f = fixture(t);
  await db.suggestionSubjects.clear(); await db.suggestionOccurrences.clear(); await db.suggestionDecisions.clear();
  f.renderPage(); await tick(); const card = cards(f.renderPage())[0]!;
  const put = db.suggestionSubjects.put.bind(db.suggestionSubjects);
  t.mock.method(db.suggestionSubjects, 'put', async (...args: Parameters<typeof put>) => {
    const result = await put(...args); f.switchAccount(); return result;
  });
  await (card.onReject as () => Promise<void>)();
  const DatabaseDexie = db.constructor as typeof import('dexie').default;
  const rows = await DatabaseDexie.ignoreTransaction(() => Promise.all([
    db.suggestionSubjects.count(), db.suggestionOccurrences.count(), db.suggestionDecisions.count(),
  ]));
  assert.deepEqual(rows, [0, 0, 0]);
});

test('same-account decision still publishes, mirrors and updates the loaded page', async t => {
  const f = fixture(t); let mirrors = 0; let publications = 0;
  f.renderPage(); await tick(); const card = cards(f.renderPage())[0]!;
  t.mock.method(suggestionRegistry, 'recordDecision', async () => {});
  t.mock.method(suggestionRegistry, 'resolve', async () => undefined);
  t.mock.method(suggestionRegistrySync, 'publishPending', async () => { publications++; return { kind: 'nothing-pending' }; });
  t.mock.method(suggestionsSync, 'addReply', async () => { mirrors++; return { success: true, id: 'reply' }; });
  t.mock.method(suggestionsSync, 'updateSuggestionStatus', async () => { mirrors++; return { success: true }; });
  await (card.onReject as () => Promise<void>)();
  assert.equal(publications, 1); assert.equal(mirrors, 2);
  assert.equal(cards(f.renderPage()).length, 0);
});

test('passing a new auth status object for the same session does not cancel a pending decision', async t => {
  const f = fixture(t); const wait = gate(); let publications = 0; let mirrors = 0;
  f.renderPage(); await tick(); const card = cards(f.renderPage())[0]!;
  t.mock.method(suggestionRegistry, 'recordDecision', async () => { await wait.pending; });
  t.mock.method(suggestionRegistry, 'resolve', async () => undefined);
  t.mock.method(suggestionRegistrySync, 'publishPending', async () => { publications++; return { kind: 'nothing-pending' }; });
  t.mock.method(suggestionsSync, 'addReply', async () => { mirrors++; return { success: true, id: 'reply' }; });
  t.mock.method(suggestionsSync, 'updateSuggestionStatus', async () => { mirrors++; return { success: true }; });
  const pending = (card.onReject as () => Promise<void>)();
  await tick(); f.props.googleAuth = { ...f.props.googleAuth }; f.renderPage(); await tick();
  assert.equal(cards(f.renderPage())[0]?.isProcessing, true);
  wait.finish(); await pending;
  assert.equal(publications, 1); assert.equal(mirrors, 2);
  assert.equal(cards(f.renderPage()).length, 0);
});

test('session renewal for the same account releases processing and preserves the proposal while reloading', async t => {
  const f = fixture(t); const wait = gate();
  f.renderPage(); await tick(); const card = cards(f.renderPage())[0]!;
  t.mock.method(suggestionRegistry, 'recordDecision', async () => { await wait.pending; });
  const pending = (card.onReject as () => Promise<void>)();
  await tick(); assert.equal(cards(f.renderPage())[0]?.isProcessing, true);
  f.auth.generation++;
  f.props.googleAuth = { ...f.props.googleAuth };
  f.renderPage(); await tick();
  assert.equal(cards(f.renderPage())[0]?.isProcessing, false);
  wait.finish(); await pending;
  assert.equal((cards(f.renderPage())[0]?.suggestion as AgentSuggestion).id, 'a-suggestion');
});

test('badge teardown during legacy ingestion cannot publish or update the next account', async t => {
  const f = fixture(t); const wait = gate(); let publications = 0; const badges: number[] = [];
  t.mock.method(suggestionRegistry, 'ingestLegacy', async () => { await wait.pending; });
  t.mock.method(suggestionRegistrySync, 'publishPending', async () => { publications++; return { kind: 'nothing-pending' }; });
  f.harness.render(() => useSuggestionsBadge({ googleAuth: f.props.googleAuth, setSuggestionsBadge: count => badges.push(count), updateSyncHealth: () => {}, addLog: () => {} }));
  await tick(); f.switchAccount(); f.harness.stop(); wait.finish(); await tick();
  assert.equal(publications, 0); assert.deepEqual(badges, []);
});

test('agent bridge polling restarts for renewed sessions even when the access token stays the same', async t => {
  const f = fixture(t);
  const callbacks = new Set<() => void>();
  const browserDocument = { addEventListener: (_event: string, callback: () => void) => callbacks.add(callback),
    removeEventListener: (_event: string, callback: () => void) => callbacks.delete(callback) };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browserDocument });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  let initialized = 0;
  t.mock.method(agentBridge, 'init', async () => { initialized++; });
  t.mock.getter(agentBridge, 'initialized', () => true);
  t.mock.method(agentBridge, 'fetchPendingWrites', async () => []);
  const args = { googleAuth: f.props.googleAuth, addLog: () => {} };
  const render = () => f.harness.render(() => useAgentBridgePolling(args));
  render();
  callbacks.forEach(callback => callback()); await tick();
  assert.equal(initialized, 1);
  f.auth.generation++;
  args.googleAuth = { ...args.googleAuth };
  render();
  callbacks.forEach(callback => callback()); await tick();
  assert.equal(initialized, 2);
  assert.equal(callbacks.size, 1, 'the previous session listener must be removed');
  args.googleAuth = { ...args.googleAuth };
  render();
  assert.equal(callbacks.size, 1);
});

test('settings hydration rolls back if the account changes during its database write', async t => {
  const f = fixture(t);
  await db.settings.clear();
  const writeFinished = gate();
  const originalPut = db.settings.put.bind(db.settings);
  t.mock.method(db.settings, 'put', async (...args: Parameters<typeof originalPut>) => {
    const result = await originalPut(...args);
    f.switchAccount(); writeFinished.finish();
    return result;
  });
  t.mock.method(googleService, 'getTaskLists', async () => []);
  t.mock.method(taskDriveBackup, 'loadDetailed', async () => ({ kind: 'loaded', payload: {
    timestamp: 1, data: { settings: [{ id: 'gemini_model', value: 'old-a-model' }], tasks: [] },
  } }));
  f.harness.render(() => useDriveSyncOrchestration({
    googleAuth: f.props.googleAuth, setGoogleAuth: () => {}, setGoogleTaskLists: () => {}, setSelectedModel: () => {},
    setUiScale: () => {}, setLastSync: () => {}, addLog: () => {}, updateSyncHealth: () => {},
  }));
  await writeFinished.pending;
  await tick();
  const DatabaseDexie = db.constructor as typeof import('dexie').default;
  assert.equal(await DatabaseDexie.ignoreTransaction(() => db.settings.get('gemini_model')), undefined);
});

test('task backup hydration checks account ownership before its first settings write', async t => {
  const f = fixture(t); const wait = gate(); const settings: unknown[] = [];
  t.mock.method(googleService, 'getTaskLists', async () => []);
  t.mock.method(taskDriveBackup, 'loadDetailed', async () => {
    await wait.pending;
    return { kind: 'loaded', payload: { timestamp: 1, data: { settings: [{ id: 'gemini_model', value: 'old-a-model' }], tasks: [] } } };
  });
  t.mock.method(db.settings, 'put', async (value: { id: string; value: string }) => { settings.push(value); return value.id; });
  f.harness.render(() => useDriveSyncOrchestration({
    googleAuth: f.props.googleAuth, setGoogleAuth: () => {}, setGoogleTaskLists: () => {}, setSelectedModel: () => {},
    setUiScale: () => {}, setLastSync: () => {}, addLog: () => {}, updateSyncHealth: () => {},
  }));
  await tick(); f.switchAccount(); wait.finish(); await tick();
  assert.deepEqual(settings, []);
});
