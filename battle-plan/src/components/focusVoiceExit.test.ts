import assert from 'node:assert/strict';
import test from 'node:test';
import type { FocusEditor as FocusEditorComponent } from './FocusEditor.tsx';
import type { useAudioRecorder as RecorderHook } from '../hooks/useAudioRecorder.ts';
import type { UnifiedTask } from '../types.ts';
import { getEditorCloseIntent, getEditorTaskSnapshot } from '../utils/editorInteraction.ts';
import { findElement, recorderHarness } from '../hooks/audioRecorderTestHarness.ts';

test('FocusEditor fences save and delete through pending permission and completed audio', async () => {
    const env = recorderHarness();
    const { useAudioRecorder } = env.load<{ useAudioRecorder: typeof RecorderHook }>(new URL('../hooks/useAudioRecorder.ts', import.meta.url));
    const { FocusEditor } = env.load<{ FocusEditor: typeof FocusEditorComponent }>(new URL('./FocusEditor.tsx', import.meta.url), {
        'lucide-react': new Proxy({}, { get: (_target, name) => String(name) }),
        '../types': { hasUsableAuth: () => false }, '../db': { db: {} },
        'dexie-react-hooks': { useLiveQuery: () => undefined },
        '../utils/calendarPresentation': { isCalendarReadonly: () => false },
        '../utils/calendarUtils': { normalizeClockTime: () => null },
        '../utils/editorInteraction': { getEditorCloseIntent, getEditorTaskSnapshot },
        './ui/OverlaySurface': { OverlaySurface: 'Overlay' }, '../utils/taskSharing': {},
    });
    const target = { current: null as number | null };
    const calls = { save: 0, delete: 0, close: 0 };
    let hook!: ReturnType<typeof RecorderHook>;
    const task: UnifiedTask = { id: 42, title: 'Task', type: 'task', status: 'pending', urgency: 1, subTasks: [], createdAt: 1, updatedAt: 1 };
    const render = () => env.render(() => {
        hook = useAudioRecorder();
        return FocusEditor({ editingTask: task, activeVoiceUpdateId: target.current, activeVoiceUpdateIdRef: target,
            isRecording: hook.isRecording, hasRecordingSession: hook.hasRecordingSession,
            startRecording: hook.startRecording, stopRecording: hook.stopRecording,
            setActiveVoiceUpdateId: () => {}, setEditingTask: value => { if (value === null) calls.close++; },
            isOverCapacity: () => false, getDeadlineColor: () => '', formatTimeLeft: () => '', handleExport: () => {},
            handleDeleteTask: async () => { calls.delete++; return true; }, handleToggleTask: async () => null,
            googleAuth: { state: 'SIGNED_OUT', accessToken: null }, handleSyncToGoogle: () => {}, handlePrepareInvitation: async () => '',
            handleSaveEdit: async () => { calls.save++; return { status: 'success' }; }, onNotice: () => {}, onRestoreCalendarBlock: async () => {},
        } satisfies Parameters<typeof FocusEditorComponent>[0]);
    });
    const buttons = (tree: unknown) => {
        const save = findElement(tree, element => element.type === 'button' && Array.isArray(element.props.children) && element.props.children.includes('Uložit změny'));
        const remove = findElement(tree, element => element.type === 'button' && element.props.children === 'Odstranit záznam');
        assert.ok(save); assert.ok(remove);
        return [save, remove];
    };
    const initial = render();
    const mic = findElement(initial, element => element.props['aria-label'] === 'Spustit diktování');
    assert.ok(mic);
    (mic.props.onClick as () => void)();
    // Even a handler captured before React renders the accepted reservation must be fenced.
    for (const button of buttons(initial)) {
        (button.props.onClick as () => void)();
        for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    assert.deepEqual(calls, { save: 0, delete: 0, close: 0 });
    assert.ok(buttons(render()).every(button => button.props.disabled === true));
    env.requests[0].resolve(new env.FakeStream());
    for (let i = 0; i < 5; i++) await Promise.resolve();
    render(); hook.stopRecording(); env.flushStops();
    const completed = buttons(render());
    assert.ok(completed.every(button => button.props.disabled === true));
    for (const button of completed) (button.props.onClick as () => void)();
    assert.deepEqual(calls, { save: 0, delete: 0, close: 0 });
    hook.clearAudio(); target.current = null;
    const idle = buttons(render());
    assert.ok(idle.every(button => button.props.disabled === false));
    (idle[0].props.onClick as () => void)();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(calls, { save: 1, delete: 0, close: 1 });
    env.unmount();
});
