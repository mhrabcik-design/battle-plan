import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { useAudioRecorder as RecorderHook } from './hooks/useAudioRecorder.ts';
import { recorderHarness } from './hooks/audioRecorderTestHarness.ts';

function appBoundary() {
    const env = recorderHarness();
    const { useAudioRecorder } = env.load<{ useAudioRecorder: typeof RecorderHook }>(new URL('./hooks/useAudioRecorder.ts', import.meta.url));
    const hook = env.render(useAudioRecorder);
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ['selectView', 'startTaskRecording'].includes(node.name.getText(tree))) {
            assert.ok(node.initializer && ts.isCallExpression(node.initializer));
            callbacks.set(node.name.getText(tree), node.initializer.arguments[0].getText(tree));
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(callbacks.size, 2, 'exercise the actual App callbacks');
    const code = ts.transpileModule([...callbacks].map(([name, callback]) => `exports.${name} = ${callback};`).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    let view = 'battle';
    const notices: string[] = [];
    const processing = { current: false };
    const exports: {
        selectView?: (view: string) => void;
        startTaskRecording?: typeof hook.startRecording;
    } = {};
    runInNewContext(code, {
        exports, Promise,
        startRecording: hook.startRecording,
        hasRecordingSession: hook.hasRecordingSession,
        get audioBlob() { return env.render(useAudioRecorder).audioBlob; },
        isProcessingRef: processing,
        setNotice: (notice: string) => notices.push(notice),
        setViewMode: (next: string) => { view = next; },
        setSearchQuery: () => {}, setPlanningFilter: () => {},
    });
    return { env, hook, processing, notices, get view() { return view; },
        select: exports.selectView!, start: exports.startTaskRecording! };
}

test('App fences navigation and new voice ownership from acquisition through audio processing', async () => {
    const app = appBoundary();
    let owner = 1;
    const first = app.start({ onAccepted: () => { owner = 1; } });
    app.select('worklogs');
    assert.equal(app.view, 'battle', 'pending permission must not overlap the WorkLog recorder');
    assert.equal(await app.start({ onAccepted: () => { owner = 2; } }), false);
    assert.equal(owner, 1);
    app.env.requests[0].resolve(new app.env.FakeStream());
    assert.equal(await first, true);
    app.hook.stopRecording();
    app.select('worklogs');
    assert.equal(app.view, 'battle', 'onstop has not published the blob yet');
    assert.equal(await app.start({ onAccepted: () => { owner = 2; } }), false);
    app.env.flushStops();
    assert.equal(await app.start({ onAccepted: () => { owner = 2; } }), false);
    assert.equal(app.env.acquisitionCalls, 1);
    app.hook.clearAudio();
    app.processing.current = true;
    app.select('worklogs');
    assert.equal(app.view, 'battle');
    assert.equal(await app.start({ onAccepted: () => { owner = 2; } }), false);
    app.processing.current = false;
    app.select('worklogs');
    assert.equal(app.view, 'worklogs');
    assert.equal(app.notices.length, 3);
    app.env.unmount();
});

test('cancelled App acquisition cannot start a microphone after leaving for WorkLogs', async () => {
    const app = appBoundary();
    const pending = app.start({});
    app.hook.stopRecording();
    app.select('worklogs');
    assert.equal(app.view, 'battle', 'the permission reservation still awaits cleanup');
    const stream = new app.env.FakeStream();
    app.env.requests[0].resolve(stream);
    assert.equal(await pending, false);
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    app.select('worklogs');
    assert.equal(app.view, 'worklogs');
    assert.equal(app.env.recorders.length, 0);
    app.env.unmount();
});
