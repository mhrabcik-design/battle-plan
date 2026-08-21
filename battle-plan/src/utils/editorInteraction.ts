export type EditorCloseIntent = 'stop-recording' | 'confirm-discard' | 'close';

export function getEditorCloseIntent({ recording, dirty }: { recording: boolean; dirty: boolean }): EditorCloseIntent {
  if (recording) return 'stop-recording';
  if (dirty) return 'confirm-discard';
  return 'close';
}
