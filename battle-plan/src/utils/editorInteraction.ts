import type { UnifiedTask } from '../types.ts';

export type EditorCloseIntent = 'stop-recording' | 'confirm-discard' | 'close';

export function getEditorCloseIntent({ recording, dirty }: { recording: boolean; dirty: boolean }): EditorCloseIntent {
  if (recording) return 'stop-recording';
  if (dirty) return 'confirm-discard';
  return 'close';
}

export const getEditorTaskSnapshot = (task: UnifiedTask): string => JSON.stringify({ ...task, updatedAt: 0 });

/** Completion keeps draft content and advances only a directly preceding revision. */
export function applySavedEditorStatus(task: UnifiedTask, saved: Pick<UnifiedTask, 'status' | 'updatedAt' | 'protocolRevision'>): UnifiedTask {
  const protocolRevision = saved.protocolRevision?.base_revision === (task.protocolRevision?.revision_id ?? null)
    ? saved.protocolRevision
    : task.protocolRevision;
  return { ...task, status: saved.status, updatedAt: saved.updatedAt, protocolRevision };
}
