import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SuggestionCard as CardComponent } from './SuggestionCard.tsx';
import type { useAudioRecorder as RecorderHook } from '../hooks/useAudioRecorder.ts';
import { findElement, recorderHarness } from '../hooks/audioRecorderTestHarness.ts';

const icons = new Proxy({}, { get: (_target, name) => String(name) });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function setup() {
    const env = recorderHarness();
    const hook = env.load<{ useAudioRecorder: typeof RecorderHook }>(new URL('../hooks/useAudioRecorder.ts', import.meta.url));
    const { SuggestionCard } = env.load<{ SuggestionCard: typeof CardComponent }>(new URL('./SuggestionCard.tsx', import.meta.url), {
        'lucide-react': icons,
        '../hooks/useAudioRecorder': hook,
        '../services/suggestionRegistry': { effectiveSuggestionStatus: () => 'open' },
        './ui/MonthDatePicker': { MonthDatePicker: 'DatePicker' },
    });
    const sent: Blob[] = [];
    const props = {
        suggestion: { id: 's', title: 'Suggestion', description: '', category: 'task', status: 'open', created_at: 1,
            source: 'fixture', reply_count: 0, last_reply_at: null,
            context: { priority: 'medium', deadline: null, related_task_ids: [], related_email_ids: [] } },
        replies: [], isProcessing: false, expandedTextReply: false,
        onAccept: async () => {}, onReject: async () => {}, onDefer: async () => {}, onTextReply: async () => {},
        onVoiceReply: async (blob: Blob) => { sent.push(blob); }, onUpdate: async () => {}, onDelete: async () => {},
        onConfirmSameOccurrence: async () => {}, onConfirmDistinct: async () => {}, onExpandTextReply: () => {},
    } satisfies Parameters<typeof CardComponent>[0];
    const render = () => env.render(() => SuggestionCard(props));
    const voiceClick = () => {
        const button = findElement(render(), element => element.type === 'button' && 'aria-pressed' in element.props);
        assert.ok(button);
        return (button.props.onClick as () => void | Promise<void>)();
    };
    return { env, sent, render, voiceClick };
}

test('SuggestionCard unmount while acquiring permission discards the late stream and reply', async () => {
    const { env, sent, voiceClick } = setup();
    const pending = voiceClick();
    env.unmount();
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    await pending; await settle();
    env.flushStops();
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(env.recorders.length, 0);
    assert.equal(env.lateUpdates, 0);
    assert.deepEqual(sent, []);
});

test('SuggestionCard unmount while recording stops the recorder and ignores captured callbacks', async () => {
    const { env, sent, voiceClick } = setup();
    const pending = voiceClick();
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    await pending; await settle();
    const recorder = env.recorders[0];
    const staleData = recorder.ondataavailable;
    const staleStop = recorder.onstop;
    env.unmount();
    staleData?.({ data: new Blob(['late']) }); staleStop?.(); env.flushStops();
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(recorder.stops, 1);
    assert.equal(recorder.onstop, null);
    assert.equal(recorder.ondataavailable, null);
    assert.equal(env.timers.size, 0);
    assert.equal(env.frames.size, 0);
    assert.equal(env.lateUpdates, 0);
    assert.deepEqual(sent, []);
});

test('SuggestionCard sends one normal recording with the recorder MIME and consumes it once', async () => {
    const { env, sent, render, voiceClick } = setup();
    const pending = voiceClick();
    const stream = new env.FakeStream();
    env.requests[0].resolve(stream);
    await pending; await settle();
    voiceClick(); env.flushStops(); render(); await settle(); render(); await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'audio/mp4');
    assert.equal(await sent[0].text(), 'voice');
    assert.deepEqual(stream.tracks.map(track => track.stops), [1, 1]);
    env.unmount();
});
