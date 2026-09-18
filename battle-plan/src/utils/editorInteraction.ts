import type { UnifiedTask } from '../types.ts';

export type EditorCloseIntent = 'stop-recording' | 'confirm-discard' | 'close';

export function getEditorCloseIntent({ recording, dirty }: { recording: boolean; dirty: boolean }): EditorCloseIntent {
  if (recording) return 'stop-recording';
  if (dirty) return 'confirm-discard';
  return 'close';
}

export const getEditorTaskSnapshot = (task: UnifiedTask): string => JSON.stringify({ ...task, updatedAt: 0 });

/** Completion saves only status; text typed before or during the request stays a draft. */
export function applySavedEditorStatus(task: UnifiedTask, saved: Pick<UnifiedTask, 'status' | 'updatedAt'>): UnifiedTask {
  return { ...task, status: saved.status, updatedAt: saved.updatedAt };
}
