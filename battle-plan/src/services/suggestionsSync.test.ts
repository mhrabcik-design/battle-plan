/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  DriveJsonRead,
  DriveJsonReadResult,
  DriveJsonWrite,
  DriveStoreStatus,
} from './driveJsonStore.ts';
import type { SuggestionsStore } from './suggestionsSync.ts';

class MissingRepliesStore implements SuggestionsStore {
  readonly lastStatus: DriveStoreStatus = { code: 'ready', message: 'ready' };
  writtenPayload: unknown = null;

  async init(): Promise<boolean> { return true; }
  async readJsonFile<T>(): Promise<DriveJsonRead<T> | null> { return null; }
  async readJsonFileWithStatus<T>(): Promise<DriveJsonReadResult<T>> { return { kind: 'missing-file' }; }
  async readJsonFilesWithStatus<T>() {
    if (!this.writtenPayload) return { kind: 'missing-file' as const };
    return {
      kind: 'loaded' as const,
      files: [{ fileId: 'new-replies-file', etag: '"etag-1"', data: this.writtenPayload as T }],
    };
  }
  async writeJsonFile(_name: string, payload: unknown): Promise<DriveJsonWrite> {
    this.writtenPayload = payload;
    return { fileId: 'new-replies-file' };
  }
  async trashFile(): Promise<void> {}
  async uploadBlob(): Promise<DriveJsonWrite | null> { return null; }
}

test('the first reply creates the replies file instead of reporting a false success', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  const { SuggestionsSync } = await import('./suggestionsSync.ts');
  const store = new MissingRepliesStore();
  const sync = new SuggestionsSync(store);
  await sync.init();

  const result = await sync.addReply({
    suggestion_id: 'proposal-1',
    type: 'text',
    content: 'Rozumím.',
    action: null,
  });

  assert.equal(result.success, true);
  assert.ok(result.id);
  assert.deepEqual(
    (store.writtenPayload as { replies: Array<{ suggestion_id: string }> }).replies.map((reply) => reply.suggestion_id),
    ['proposal-1'],
  );
});

class ConcurrentRepliesStore implements SuggestionsStore {
  readonly lastStatus: DriveStoreStatus = { code: 'ready', message: 'ready' };
  files: Array<{ fileId: string; etag: string; data: { version: number; last_updated: number; replies: unknown[] } }> = [];
  writeCount = 0;
  trashed: string[] = [];

  async init(): Promise<boolean> { return true; }
  async readJsonFile<T>(): Promise<DriveJsonRead<T> | null> { return null; }
  async readJsonFileWithStatus<T>(): Promise<DriveJsonReadResult<T>> { return { kind: 'missing-file' }; }
  async readJsonFilesWithStatus<T>() {
    if (this.files.length === 0) return { kind: 'missing-file' as const };
    return { kind: 'loaded' as const, files: structuredClone(this.files) as Array<DriveJsonRead<T>> };
  }
  async writeJsonFile(
    _name: string,
    payload: unknown,
    fileId?: string | null,
  ): Promise<DriveJsonWrite> {
    this.writeCount++;
    if (this.writeCount === 1) {
      this.files = [
        {
          fileId: 'replies-a',
          etag: '"etag-a"',
          data: {
            version: 1,
            last_updated: 1,
            replies: [{
              id: 'remote-reply', suggestion_id: 'proposal-remote', created_at: 1,
              type: 'text', content: 'Remote', action: null,
            }],
          },
        },
        { fileId: 'replies-b', etag: '"etag-b"', data: structuredClone(payload) as never },
      ];
    } else {
      const target = this.files.find((candidate) => candidate.fileId === fileId) ?? this.files[0];
      target.data = structuredClone(payload) as never;
      target.etag = '"etag-updated"';
    }
    return { fileId: fileId ?? 'replies-b' };
  }
  async trashFile(fileId: string): Promise<void> {
    this.trashed.push(fileId);
    this.files = this.files.filter((file) => file.fileId !== fileId);
  }
  async uploadBlob(): Promise<DriveJsonWrite | null> { return null; }
}

test('concurrent first replies converge without losing either reply', async () => {
  const { SuggestionsSync } = await import('./suggestionsSync.ts');
  const store = new ConcurrentRepliesStore();
  const sync = new SuggestionsSync(store);
  await sync.init();

  const result = await sync.addReply({
    suggestion_id: 'proposal-local',
    type: 'text',
    content: 'Local',
    action: null,
  });

  assert.equal(result.success, true);
  assert.ok(result.id);
  assert.equal(store.writeCount, 2);
  assert.deepEqual(store.trashed, ['replies-b']);
  assert.deepEqual(
    store.files[0].data.replies.map((reply) => (reply as { id: string }).id).sort(),
    ['remote-reply', result.id].sort(),
  );
});
