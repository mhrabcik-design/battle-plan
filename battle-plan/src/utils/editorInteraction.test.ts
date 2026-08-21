import assert from 'node:assert/strict';
import test from 'node:test';
import { getEditorCloseIntent } from './editorInteraction.ts';

test('recording Escape stops recording before considering close', () => {
  assert.equal(getEditorCloseIntent({ recording: true, dirty: true }), 'stop-recording');
});

test('dirty editor requests confirmation and pristine editor closes', () => {
  assert.equal(getEditorCloseIntent({ recording: false, dirty: true }), 'confirm-discard');
  assert.equal(getEditorCloseIntent({ recording: false, dirty: false }), 'close');
});
