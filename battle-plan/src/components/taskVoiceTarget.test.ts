import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskCard as TaskCardComponent } from './TaskCard.tsx';
import type { FocusEditor as FocusEditorComponent } from './FocusEditor.tsx';
import type { UnifiedTask } from '../types.ts';
import type { RecorderOptions, useAudioRecorder as RecorderHook } from '../hooks/useAudioRecorder.ts';
import { getEditorCloseIntent, getEditorTaskSnapshot } from '../utils/editorInteraction.ts';
import { findElement, recorderHarness } from '../hooks/audioRecorderTestHarness.ts';

const icons = new Proxy({}, { get: (_target, name) => String(name) });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
for (const name of ['TaskCard', 'FocusEditor'] as const) {
    function setup(start: (options: RecorderOptions) => Promise<boolean>) {
        const env = recorderHarness();
        const target = { current: null as number | null };
        let state: number | null = null;
        const calendar = { isCalendarReadonly: () => false, calendarTaskLabel: () => 'Task', openReadonlyCalendarTask: () => false };
        const task: UnifiedTask = { id: 42, title: 'Task', type: 'task', status: 'pending', urgency: 1, subTasks: [], createdAt: 1, updatedAt: 1 };
        const shared = { activeVoiceUpdateId: null, activeVoiceUpdateIdRef: target,
            setActiveVoiceUpdateId: (id: number | null) => { state = id; }, startRecording: start, stopRecording: () => {},
            isOverCapacity: () => false, getDeadlineColor: () => '', formatTimeLeft: () => '', setEditingTask: () => {},
            handleExport: () => {}, handleDeleteTask: async () => false, handleToggleTask: async () => null };
        let tree: unknown;
        if (name === 'TaskCard') {
            const { TaskCard } = env.load<{ TaskCard: typeof TaskCardComponent }>(new URL('./TaskCard.tsx', import.meta.url), {
                'lucide-react': icons, 'framer-motion': { motion: { article: 'article', div: 'div' } },
                '../utils/calendarPresentation': calendar,
                '../utils/taskListPresentation': { getTaskCompletionClasses: () => ({}), getTaskVisualTone: () => 'task' },
            });
            tree = env.render(() => TaskCard({ ...shared, task, getUrgencyColor: () => '', toggleSubtask: () => {} } satisfies Parameters<typeof TaskCardComponent>[0]));
        } else {
            const { FocusEditor } = env.load<{ FocusEditor: typeof FocusEditorComponent }>(new URL('./FocusEditor.tsx', import.meta.url), {
                'lucide-react': icons, '../types': { hasUsableAuth: () => false }, '../db': { db: {} },
                'dexie-react-hooks': { useLiveQuery: () => undefined },
                '../utils/calendarPresentation': calendar,
                '../utils/calendarUtils': { normalizeClockTime: () => null },
                '../utils/editorInteraction': { getEditorTaskSnapshot: () => 'task' },
                './ui/OverlaySurface': { OverlaySurface: 'Overlay' }, '../utils/taskSharing': {},
            });
            tree = env.render(() => FocusEditor({ ...shared, editingTask: task, isRecording: false, hasRecordingSession: () => false, googleAuth: { state: 'SIGNED_OUT', accessToken: null },
                handleSyncToGoogle: () => {}, handlePrepareInvitation: async () => '', handleSaveEdit: async () => ({ status: 'success' }),
                onNotice: () => {}, onRestoreCalendarBlock: async () => {} } satisfies Parameters<typeof FocusEditorComponent>[0]));
        }
        const button = findElement(tree, element => element.type === 'button' && String(element.props['aria-label']).match(/Diktovat aktualizaci|Spustit diktování/) !== null);
        assert.ok(button);
        return { target, env, click: button.props.onClick as () => void, get state() { return state; } };
    }
    test(`${name} ignored start cannot replace an existing task or general microphone target`, async () => {
        const ui = setup(async () => false);
        for (const owner of [11, null]) {
            ui.target.current = owner;
            ui.click(); await settle();
            assert.equal(ui.target.current, owner);
            assert.equal(ui.state, null);
        }
        ui.env.unmount();
    });
    test(`${name} accepted startup owns its target and failed startup resets matching state`, async () => {
        const ui = setup(async options => { options.onAccepted?.(); throw new Error('permission denied'); });
        ui.click();
        assert.equal(ui.target.current, 42);
        assert.equal(ui.state, 42);
        await settle();
        assert.equal(ui.target.current, null);
        assert.equal(ui.state, null);
        ui.env.unmount();
    });
}

test('FocusEditor close observes pending permission synchronously and waits for completed audio consumption', async () => {
    const env = recorderHarness();
    const { useAudioRecorder } = env.load<{ useAudioRecorder: typeof RecorderHook }>(new URL('../hooks/useAudioRecorder.ts', import.meta.url));
    const { FocusEditor } = env.load<{ FocusEditor: typeof FocusEditorComponent }>(new URL('./FocusEditor.tsx', import.meta.url), {
        'lucide-react': icons, '../types': { hasUsableAuth: () => false }, '../db': { db: {} },
        'dexie-react-hooks': { useLiveQuery: () => undefined },
        '../utils/calendarPresentation': { isCalendarReadonly: () => false },
        '../utils/calendarUtils': { normalizeClockTime: () => null },
        '../utils/editorInteraction': { getEditorCloseIntent, getEditorTaskSnapshot },
        './ui/OverlaySurface': { OverlaySurface: 'Overlay' }, '../utils/taskSharing': {},
    });
    const target = { current: null as number | null };
    let closed = 0;
    let hook!: ReturnType<typeof RecorderHook>;
    const task: UnifiedTask = { id: 42, title: 'Task', type: 'task', status: 'pending', urgency: 1, subTasks: [], createdAt: 1, updatedAt: 1 };
    const render = () => env.render(() => {
        hook = useAudioRecorder();
        return FocusEditor({ editingTask: task, activeVoiceUpdateId: target.current, activeVoiceUpdateIdRef: target,
            isRecording: hook.isRecording, hasRecordingSession: hook.hasRecordingSession,
            startRecording: hook.startRecording, stopRecording: hook.stopRecording,
            setActiveVoiceUpdateId: () => {}, setEditingTask: value => { if (value === null) closed++; },
            isOverCapacity: () => false, getDeadlineColor: () => '', formatTimeLeft: () => '',
            handleExport: () => {}, handleDeleteTask: async () => false, handleToggleTask: async () => null,
            googleAuth: { state: 'SIGNED_OUT', accessToken: null }, handleSyncToGoogle: () => {}, handlePrepareInvitation: async () => '',
            handleSaveEdit: async () => ({ status: 'success' }), onNotice: () => {}, onRestoreCalendarBlock: async () => {},
        } satisfies Parameters<typeof FocusEditorComponent>[0]);
    });
    const click = (tree: unknown, label: string) => {
        const button = findElement(tree, element => element.type === 'button' && element.props['aria-label'] === label);
        assert.ok(button);
        (button.props.onClick as () => void)();
    };
    const initial = render();
    click(initial, 'Spustit diktování');
    click(initial, 'Zavřít editor');
    assert.equal(closed, 0, 'accepted pending permission keeps the editor open before a recording render');
    const cancelledStream = new env.FakeStream();
    env.requests[0].resolve(cancelledStream); await settle();
    assert.deepEqual(cancelledStream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(target.current, null);
    const idle = render();
    click(idle, 'Spustit diktování');
    env.requests[1].resolve(new env.FakeStream()); await settle();
    click(render(), 'Zastavit diktování'); env.flushStops();
    click(render(), 'Zavřít editor');
    assert.equal(closed, 0, 'completed audio keeps its target until the processing boundary consumes it');
    hook.clearAudio(); target.current = null;
    click(render(), 'Zavřít editor');
    assert.equal(closed, 1);
    env.unmount();
});
