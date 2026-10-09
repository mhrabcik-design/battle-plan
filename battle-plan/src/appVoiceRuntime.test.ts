import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { useAudioRecorder as RecorderHook } from './hooks/useAudioRecorder.ts';
import { recorderHarness } from './hooks/audioRecorderTestHarness.ts';

test('App releases a failed recorder voice target after successful start and allows retry', async () => {
    const env = recorderHarness();
    const { useAudioRecorder } = env.load<{ useAudioRecorder: typeof RecorderHook }>(new URL('./hooks/useAudioRecorder.ts', import.meta.url));
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const ownershipEffects: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' &&
            node.arguments[0]?.getText(tree).includes('hasRecordingSession') &&
            node.arguments[0]?.getText(tree).includes('activeVoiceUpdateIdRef')) ownershipEffects.push(node.getText(tree));
        ts.forEachChild(node, visit);
    };
    visit(tree);
    const code = ts.transpileModule(`exports.render = () => { ${ownershipEffects.join(';\n')} };`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    let hook = env.render(useAudioRecorder);
    let owner: number | null = null;
    const target = { current: null as number | null };
    let previousDeps: unknown[] | undefined;
    const exports: { render?: () => void } = {};
    runInNewContext(code, {
        exports,
        queueMicrotask,
        get activeVoiceUpdateId() { return owner; },
        activeVoiceUpdateIdRef: target,
        setActiveVoiceUpdateId: (value: number | null) => { owner = value; },
        get isRecording() { return hook.isRecording; },
        get audioBlob() { return hook.audioBlob; },
        hasRecordingSession: hook.hasRecordingSession,
        isProcessingRef: { current: false },
        useEffect: (callback: () => void, deps: unknown[]) => {
            if (!previousDeps || deps.some((value, index) => !Object.is(value, previousDeps![index]))) callback();
            previousDeps = deps;
        },
    });
    const render = async () => { hook = env.render(useAudioRecorder); exports.render!(); await Promise.resolve(); };
    await render();
    const pending = hook.startRecording({ onAccepted: () => { owner = 42; target.current = 42; } });
    await render();
    assert.equal(owner, 42, 'pending acquisition retains ownership');
    env.requests[0].resolve(new env.FakeStream());
    await pending;
    await render();
    assert.equal(owner, 42);
    env.recorders[0].onerror?.();
    await render();
    assert.equal(owner, null);
    assert.equal(target.current, null);
    assert.equal(hook.audioBlob, null);
    const retry = hook.startRecording({ onAccepted: () => { owner = 42; target.current = 42; } });
    env.requests[1].resolve(new env.FakeStream());
    assert.equal(await retry, true);
    await render();
    assert.equal(owner, 42);
    env.recorders[1].onerror?.();
    hook = env.render(useAudioRecorder); exports.render!();
    const replacement = hook.startRecording({ onAccepted: () => { owner = 77; target.current = 77; } });
    await Promise.resolve();
    assert.equal(owner, 77, 'queued cleanup must not clear a newly accepted session');
    assert.equal(target.current, 77);
    env.requests[2].resolve(new env.FakeStream());
    assert.equal(await replacement, true);
    env.unmount();
});
