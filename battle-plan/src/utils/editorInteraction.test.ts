import assert from 'node:assert/strict';
import test from 'node:test';
import { applySavedEditorStatus, getEditorCloseIntent, getEditorTaskSnapshot } from './editorInteraction.ts';
import type { UnifiedTask } from '../types.ts';

test('recording Escape stops recording before considering close', () => {
  assert.equal(getEditorCloseIntent({ recording: true, dirty: true }), 'stop-recording');
});

test('dirty editor requests confirmation and pristine editor closes', () => {
  assert.equal(getEditorCloseIntent({ recording: false, dirty: true }), 'confirm-discard');
  assert.equal(getEditorCloseIntent({ recording: false, dirty: false }), 'close');
});

test('persisting completion keeps unsaved fields dirty across completion and reopening', () => {
  const initial: UnifiedTask = { id: 1, title: 'Saved title', type: 'task', urgency: 2, status: 'pending', createdAt: 1, updatedAt: 1 };
  let baseline = initial;
  let draft: UnifiedTask = { ...initial, title: 'Unsaved title', description: 'Typed while completion was pending' };
  for (const status of ['completed', 'pending'] as const) {
    const saved = { ...initial, status, updatedAt: 2 };
    baseline = applySavedEditorStatus(baseline, saved);
    draft = applySavedEditorStatus(draft, saved);
    assert.equal(draft.title, 'Unsaved title');
    assert.equal(draft.description, 'Typed while completion was pending');
    assert.equal(getEditorCloseIntent({ recording: false, dirty: getEditorTaskSnapshot(baseline) !== getEditorTaskSnapshot(draft) }), 'confirm-discard');
  }
  assert.equal(getEditorTaskSnapshot(applySavedEditorStatus(initial, { status: 'completed', updatedAt: 2 })),
    getEditorTaskSnapshot({ ...initial, status: 'completed', updatedAt: 3 }));
});
