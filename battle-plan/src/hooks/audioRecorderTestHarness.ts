import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

export function recorderHarness() {
    type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
    const slots: Slot[] = [];
    let cursor = 0;
    let mounted = true;
    const effects: Array<() => void> = [];
    const updates: unknown[] = [];
    let lateUpdates = 0;
    const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const react = {
        useState(initial: unknown) {
            const index = cursor++;
            const slot = slots[index] ??= { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
            return [slot.value, (value: unknown) => {
                if (!mounted) lateUpdates++;
                slot.value = typeof value === 'function' ? (value as (previous: unknown) => unknown)(slot.value) : value;
                updates.push(slot.value);
            }];
        },
        useRef(initial: unknown) {
            const slot = slots[cursor++] ??= { value: { current: initial } };
            return slot.value;
        },
        useCallback(callback: unknown, deps: unknown[]) {
            const slot = slots[cursor++] ??= {};
            if (!sameDeps(slot.deps, deps)) { slot.value = callback; slot.deps = deps; }
            return slot.value;
        },
        useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
            const slot = slots[cursor++] ??= {};
            if (sameDeps(slot.deps, deps)) return;
            effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() || undefined; slot.deps = deps; });
        },
        useId() { cursor++; return 'card'; },
    };
    const timers = new Map<number, () => void>();
    const frames = new Map<number, () => void>();
    let nextHandle = 1;
    let acquisitionCalls = 0;
    const requests: ReturnType<typeof deferred<FakeStream>>[] = [];
    const recorders: FakeRecorder[] = [];
    const contexts: FakeContext[] = [];
    const stopEvents: Array<() => void> = [];
    const failures = { recorderConstruction: false, recorderStart: false, contextConstruction: false, source: false, analyser: false };
    const alerts: string[] = [];
    class FakeStream {
        tracks = [{ stops: 0, stop() { this.stops++; } }, { stops: 0, stop() { this.stops++; } }];
        getTracks() { return this.tracks; }
    }
    class FakeRecorder {
        static isTypeSupported(type: string) { return type === 'audio/mp4'; }
        mimeType = 'audio/mp4';
        state = 'inactive';
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        onerror: (() => void) | null = null;
        stops = 0;
        stream: FakeStream;
        constructor(stream: FakeStream) {
            if (failures.recorderConstruction) throw new Error('recorder construction');
            this.stream = stream;
            recorders.push(this);
        }
        start() {
            if (failures.recorderStart) throw new Error('recorder start');
            this.state = 'recording';
        }
        stop() {
            this.stops++;
            this.state = 'inactive';
            const data = this.ondataavailable;
            const stop = this.onstop;
            stopEvents.push(() => { data?.({ data: new Blob(['voice']) }); stop?.(); });
        }
    }
    class FakeNode {
        disconnects = 0;
        connect() {}
        disconnect() { this.disconnects++; }
    }
    class FakeContext {
        closes = 0;
        state = 'running';
        source = new FakeNode();
        analyser = Object.assign(new FakeNode(), {
            fftSize: 0, frequencyBinCount: 16,
            getFloatTimeDomainData(data: Float32Array) { data.fill(0); },
        });
        currentTime = 0;
        destination = {};
        constructor() {
            if (failures.contextConstruction) throw new Error('context construction');
            contexts.push(this);
        }
        createMediaStreamSource() {
            if (failures.source) throw new Error('source construction');
            return this.source;
        }
        createAnalyser() {
            if (failures.analyser) throw new Error('analyser construction');
            return this.analyser;
        }
        createOscillator() {
            return Object.assign(new FakeNode(), { type: '', frequency: { setValueAtTime() {} }, start() {}, stop() {}, onended: null });
        }
        createGain() { return Object.assign(new FakeNode(), { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }); }
        async close() { this.closes++; this.state = 'closed'; }
    }
    const sandbox = {
        Blob, Float32Array, Date, Promise,
        console: { error() {}, warn() {} },
        navigator: { mediaDevices: { getUserMedia() { acquisitionCalls++; const request = deferred<FakeStream>(); requests.push(request); return request.promise; } } },
        window: { MediaRecorder: FakeRecorder, AudioContext: FakeContext },
        MediaRecorder: FakeRecorder, AudioContext: FakeContext,
        alert: (message: string) => alerts.push(message),
        setTimeout: (callback: () => void) => { const id = nextHandle++; timers.set(id, callback); return id; },
        clearTimeout: (id: number) => timers.delete(id),
        requestAnimationFrame: (callback: () => void) => { const id = nextHandle++; frames.set(id, callback); return id; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
    };
    const modules = new Map<string, unknown>([
        ['react', { ...react, default: react }],
        ['react/jsx-runtime', { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }],
    ]);
    function load<T>(path: URL, mocks: Record<string, unknown> = {}): T {
        const source = readFileSync(path, 'utf8');
        const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
        const exports = {};
        runInNewContext(code, { ...sandbox, exports, require: (id: string) => {
            if (id in mocks) return mocks[id];
            if (modules.has(id)) return modules.get(id);
            throw new Error(`Missing test module ${id}`);
        } }, { filename: path.pathname });
        return exports as T;
    }
    return {
        load, react, modules, updates, timers, frames, failures, requests, recorders, contexts, alerts, FakeStream,
        get acquisitionCalls() { return acquisitionCalls; },
        get lateUpdates() { return lateUpdates; },
        render<T>(render: () => T) { cursor = 0; const result = render(); effects.splice(0).forEach(effect => effect()); return result; },
        unmount() { mounted = false; slots.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; }); },
        flushStops() { stopEvents.splice(0).forEach(event => event()); },
    };
}

export type Element = { type: unknown; props: Record<string, unknown> };
export function findElement(tree: unknown, predicate: (element: Element) => boolean): Element | undefined {
    if (Array.isArray(tree)) {
        for (const child of tree) { const match = findElement(child, predicate); if (match) return match; }
    } else if (tree && typeof tree === 'object' && 'props' in tree) {
        const element = tree as Element;
        if (predicate(element)) return element;
        return findElement(element.props.children, predicate);
    }
}
