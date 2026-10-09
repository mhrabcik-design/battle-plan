import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { useAudioRecorder as RecorderHook } from './useAudioRecorder.ts';
import { recorderHarness } from './audioRecorderTestHarness.ts';

function setup() {
    const env = recorderHarness();
    const { useAudioRecorder } = env.load<{ useAudioRecorder: typeof RecorderHook }>(new URL('./useAudioRecorder.ts', import.meta.url));
    const render = () => env.render(useAudioRecorder);
    return { env, render, hook: render() };
}

test('pending permission resolved after unmount releases all tracks without publishing audio or state', async () => {
    const { env, hook } = setup();
    const pending = hook.startRecording();
    env.unmount();
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    await pending;
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(env.recorders.length, 0);
    assert.equal(env.lateUpdates, 0);
    assert.equal(env.updates.filter(value => value instanceof Blob).length, 0);
});

test('concurrent starts reserve one acquisition and cannot retarget the active session', async () => {
    const { env, hook, render } = setup();
    let target = '';
    const first = hook.startRecording({ onAccepted: () => { target = 'first'; } });
    assert.equal(hook.hasRecordingSession(), true, 'navigation observes pending permission before React renders');
    const second = hook.startRecording({ onAccepted: () => { target = 'second'; } });
    assert.equal(env.acquisitionCalls, 1);
    assert.equal(target, 'first');
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    assert.equal(await first, true);
    assert.equal(await second, false);
    assert.equal(await hook.startRecording({ onAccepted: () => { target = 'third'; } }), false);
    assert.equal(target, 'first');
    assert.equal(render().isRecording, true);
    assert.equal(env.recorders.length, 1);
    env.unmount();
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
});

for (const failure of ['recorderConstruction', 'recorderStart', 'contextConstruction', 'source', 'analyser'] as const) {
    test(`partial startup failure (${failure}) releases acquired resources and permits retry`, async () => {
        const { env, hook, render } = setup();
        env.failures[failure] = true;
        const pending = hook.startRecording({ onSilence: () => {} });
        const stream = new env.FakeStream();
        env.requests[0].resolve(stream);
        await assert.rejects(pending);
        assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
        for (const recorder of env.recorders) {
            assert.equal(recorder.state, 'inactive');
            assert.equal(recorder.onstop, null);
            assert.equal(recorder.ondataavailable, null);
        }
        assert.ok(env.contexts.every(context => context.closes === 1));
        assert.equal(env.timers.size, 0);
        assert.equal(env.frames.size, 0);
        assert.equal(render().isRecording, false);
        env.failures[failure] = false;
        const retry = hook.startRecording({ onSilence: () => {} });
        env.requests[1].resolve(new env.FakeStream());
        assert.equal(await retry, true);
        env.unmount();
    });
}

test('normal stop emits one true MIME blob, releases resources and fences queued callbacks', async () => {
    const { env, hook, render } = setup();
    const pending = hook.startRecording({ onSilence: () => {} });
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    await pending;
    const recorder = env.recorders[0];
    const staleStop = recorder.onstop;
    const staleData = recorder.ondataavailable;
    hook.stopRecording();
    hook.stopRecording();
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(recorder.stops, 1);
    assert.equal(env.timers.size, 0);
    assert.equal(env.frames.size, 0);
    assert.equal(env.contexts[0].closes, 1);
    assert.equal(env.contexts[0].source.disconnects, 1);
    assert.equal(env.contexts[0].analyser.disconnects, 1);
    assert.equal(await hook.startRecording(), false, 'unconsumed audio retains its target before a processing render');
    env.flushStops();
    staleData?.({ data: new Blob(['stale']) });
    staleStop?.();
    const result = render();
    assert.equal(result.isRecording, false);
    assert.equal(result.audioBlob?.type, 'audio/mp4');
    assert.equal(await result.audioBlob?.text(), 'voice');
    assert.equal(env.updates.filter(value => value instanceof Blob).length, 1);
    assert.equal(recorder.onstop, null);
    assert.equal(recorder.ondataavailable, null);
    hook.clearAudio();
    assert.equal(render().audioBlob, null);
    assert.equal(hook.hasRecordingSession(), false);
    env.unmount();
});

test('stop during pending permission suppresses a late rejection and releases the reservation', async () => {
    const { env, hook, render } = setup();
    const pending = hook.startRecording();
    hook.stopRecording();
    env.requests[0].reject(new Error('late permission rejection'));
    assert.equal(await pending, false);
    assert.equal(hook.hasRecordingSession(), false);
    assert.equal(render().isRecording, false);
    assert.equal(render().audioBlob, null);
    env.unmount();
});

test('feedback tones own their timers and contexts through normal stop and unmount', async () => {
    const { env, hook } = setup();
    const pending = hook.startRecording({ enableFeedback: true, onSilence: () => {} });
    env.requests[0].resolve(new env.FakeStream());
    await pending;
    assert.equal(env.contexts.length, 2);
    hook.stopRecording();
    assert.equal(env.contexts.length, 3);
    assert.deepEqual(env.contexts.map(context => context.closes), [1, 1, 0]);
    const stopTone = [...env.timers.values()][0];
    stopTone();
    assert.deepEqual(env.contexts.map(context => context.closes), [1, 1, 1]);
    assert.equal(env.timers.size, 0);
    env.unmount();
    stopTone();
    assert.deepEqual(env.contexts.map(context => context.closes), [1, 1, 1]);
    assert.equal(env.frames.size, 0);
});

test('callbacks captured from a cancelled recorder cannot change a later session', async () => {
    const { env, hook, render } = setup();
    const first = hook.startRecording();
    env.requests[0].resolve(new env.FakeStream());
    await first;
    const oldRecorder = env.recorders[0];
    const oldData = oldRecorder.ondataavailable;
    const oldStop = oldRecorder.onstop;
    hook.clearAudio();
    const second = hook.startRecording();
    env.requests[1].resolve(new env.FakeStream());
    await second;
    oldData?.({ data: new Blob(['wrong session']) }); oldStop?.(); env.flushStops();
    assert.equal(render().isRecording, true);
    assert.equal(render().audioBlob, null);
    hook.stopRecording(); env.flushStops();
    assert.equal(await render().audioBlob?.text(), 'voice');
    assert.equal(env.updates.filter(value => value instanceof Blob).length, 1);
    env.unmount();
});

test('cancel during acquisition or active recording discards late audio and silence work', async () => {
    const { env, hook, render } = setup();
    const pending = hook.startRecording();
    hook.clearAudio();
    const ignored = hook.startRecording();
    assert.equal(env.acquisitionCalls, 1, 'cancel does not overlap a still pending permission request');
    assert.equal(await ignored, false);
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    assert.equal(await pending, false);
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    const next = hook.startRecording({ onSilence: () => {} });
    const activeStream = new env.FakeStream();
    env.requests[1].resolve(activeStream);
    await next;
    const recorder = env.recorders[0];
    const staleStop = recorder.onstop;
    const staleData = recorder.ondataavailable;
    const staleSilence = [...env.timers.values()][0];
    const staleFrame = [...env.frames.values()][0];
    hook.clearAudio();
    staleSilence?.();
    staleFrame?.();
    staleData?.({ data: new Blob(['late']) });
    staleStop?.();
    env.flushStops();
    assert.deepEqual(activeStream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(render().audioBlob, null);
    assert.equal(render().isRecording, false);
    assert.equal(env.timers.size, 0);
    assert.equal(env.frames.size, 0);
    assert.equal(env.updates.filter(value => value instanceof Blob).length, 0);
    env.unmount();
});

test('recording without a silence callback avoids analysis resources and still publishes true audio', async () => {
    const { env, hook, render } = setup();
    const pending = hook.startRecording();
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    assert.equal(await pending, true);
    assert.equal(env.contexts.length, 0);
    assert.equal(env.frames.size, 0);
    assert.equal(env.timers.size, 0);
    hook.stopRecording();
    env.flushStops();
    assert.equal(render().audioBlob?.type, 'audio/mp4');
    assert.equal(await render().audioBlob?.text(), 'voice');
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    env.unmount();
});
