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
  writes: Array<{ fileId?: string | null; options?: unknown }> = [];
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
    options?: unknown,
  ): Promise<DriveJsonWrite> {
    this.writeCount++;
    this.writes.push({ fileId, options });
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
  assert.deepEqual(store.writes, [
    { fileId: null, options: { createOnly: true } },
    { fileId: 'replies-a', options: { ifMatch: '"etag-a"' } },
  ]);
  assert.deepEqual(store.trashed, ['replies-b']);
  assert.deepEqual(
    store.files[0].data.replies.map((reply) => (reply as { id: string }).id).sort(),
    ['remote-reply', result.id].sort(),
  );
});

class ExistingRepliesStore implements SuggestionsStore {
  readonly lastStatus: DriveStoreStatus = { code: 'ready', message: 'ready' };
  file: DriveJsonRead<{ version: number; last_updated: number; replies: unknown[] }>;
  readCount = 0;
  writeCount = 0;
  alwaysRejectAsStale = false;
  replaceOnFirstStale: typeof this.file | null = null;
  writes: Array<{ fileId?: string | null; options?: unknown }> = [];

  constructor(etag?: string) {
    this.file = {
      fileId: 'replies-a',
      ...(etag ? { etag } : {}),
      data: { version: 1, last_updated: 1, replies: [] },
    };
  }

  async init(): Promise<boolean> { return true; }
  async readJsonFile<T>(): Promise<DriveJsonRead<T> | null> { return null; }
  async readJsonFileWithStatus<T>(): Promise<DriveJsonReadResult<T>> { return { kind: 'missing-file' }; }
  async readJsonFilesWithStatus<T>() {
    this.readCount++;
    return { kind: 'loaded' as const, files: [structuredClone(this.file) as DriveJsonRead<T>] };
  }
  async writeJsonFile(
    _name: string,
    payload: unknown,
    fileId?: string | null,
    options?: unknown,
  ): Promise<DriveJsonWrite> {
    this.writeCount++;
    this.writes.push({ fileId, options });
    if (this.alwaysRejectAsStale || this.replaceOnFirstStale) {
      if (this.replaceOnFirstStale) {
        this.file = structuredClone(this.replaceOnFirstStale);
        this.replaceOnFirstStale = null;
      }
      throw Object.assign(new Error('stale Drive revision'), { status: 412 });
    }
    this.file.data = structuredClone(payload) as typeof this.file.data;
    this.file.etag = '"etag-updated"';
    return { fileId: this.file.fileId, etag: this.file.etag };
  }
  async trashFile(): Promise<void> {}
  async uploadBlob(): Promise<DriveJsonWrite | null> { return null; }
}

test('reply publishing fails closed when the canonical replies file has no ETag', async () => {
  const { SuggestionsSync } = await import('./suggestionsSync.ts');
  const store = new ExistingRepliesStore();
  const sync = new SuggestionsSync(store);
  await sync.init();

  const result = await sync.addReply({
    suggestion_id: 'proposal-local', type: 'text', content: 'Local', action: null,
  });

  assert.deepEqual(result, { success: false });
  assert.equal(store.writeCount, 0);
});

test('reply publishing rereads and merges after a stale conditional revision', async () => {
  const { SuggestionsSync } = await import('./suggestionsSync.ts');
  const store = new ExistingRepliesStore('"etag-a"');
  store.replaceOnFirstStale = {
    fileId: 'replies-a',
    etag: '"etag-b"',
    data: {
      version: 1,
      last_updated: 2,
      replies: [{
        id: 'remote-reply', suggestion_id: 'proposal-remote', created_at: 1,
        type: 'text', content: 'Remote', action: null,
      }],
    },
  };
  const sync = new SuggestionsSync(store);
  await sync.init();

  const result = await sync.addReply({
    suggestion_id: 'proposal-local', type: 'text', content: 'Local', action: null,
  });

  assert.equal(result.success, true);
  assert.equal(store.readCount, 3);
  assert.deepEqual(store.writes, [
    { fileId: 'replies-a', options: { ifMatch: '"etag-a"' } },
    { fileId: 'replies-a', options: { ifMatch: '"etag-b"' } },
  ]);
  assert.deepEqual(
    store.file.data.replies.map((reply) => (reply as { id: string }).id).sort(),
    ['remote-reply', result.id].sort(),
  );
});

test('reply publishing bounds repeated stale-revision retries', async () => {
  const { SuggestionsSync } = await import('./suggestionsSync.ts');
  const store = new ExistingRepliesStore('"etag-a"');
  store.alwaysRejectAsStale = true;
  const sync = new SuggestionsSync(store);
  await sync.init();

  const result = await sync.addReply({
    suggestion_id: 'proposal-local', type: 'text', content: 'Local', action: null,
  });

  assert.deepEqual(result, { success: false });
  assert.equal(store.readCount, 3);
  assert.equal(store.writeCount, 3);
});
