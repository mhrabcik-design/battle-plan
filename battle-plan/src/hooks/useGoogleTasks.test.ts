import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { GoogleTaskRaw } from '../types.ts';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
const { googleService } = await import('../services/googleService.ts');
const { createGoogleTaskLoader } = await import('./useGoogleTasks.ts');
afterEach(() => mock.restoreAll());
const task = (id: string): GoogleTaskRaw => ({ id, title: id, updated: '2026-10-03T10:00:00Z' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('the latest refresh wins when same-list responses finish in reverse order', async () => {
  const first = deferred<GoogleTaskRaw[]>();
  const second = deferred<GoogleTaskRaw[]>();
  let calls = 0;
  mock.method(googleService, 'getTasks', () => ++calls === 1 ? first.promise : second.promise);
  const accepted: GoogleTaskRaw[][] = [];
  const loader = createGoogleTaskLoader('A', tasks => accepted.push(tasks), error => assert.fail(String(error)));
  const oldRead = loader.refresh();
  const newRead = loader.refresh();
  second.resolve([task('new')]); await newRead;
  first.resolve([task('old')]); await oldRead;
  assert.deepEqual(accepted, [[task('new')]]);
});

test('changing lists disposes old reads and late mutation refreshes', async () => {
  const first = deferred<GoogleTaskRaw[]>();
  const requests: string[] = [];
  mock.method(googleService, 'getTasks', (listId: string) => { requests.push(listId); return listId === 'A' ? first.promise : Promise.resolve([task('B-task')]); });
  const accepted: GoogleTaskRaw[][] = [];
  const oldLoader = createGoogleTaskLoader('A', tasks => accepted.push(tasks), error => assert.fail(String(error)));
  const oldRead = oldLoader.refresh();
  oldLoader.stop();
  const newLoader = createGoogleTaskLoader('B', tasks => accepted.push(tasks), error => assert.fail(String(error)));
  await newLoader.refresh();
  first.resolve([task('A-task')]); await oldRead;
  await oldLoader.refresh();
  assert.deepEqual(accepted, [[task('B-task')]]);
  assert.deepEqual(requests, ['A', 'B']);
});

test('sign-out or unmount discards a pending failure and prevents another fetch', async () => {
  const pending = deferred<GoogleTaskRaw[]>();
  const fetch = mock.method(googleService, 'getTasks', () => pending.promise);
  const errors: unknown[] = [];
  const loader = createGoogleTaskLoader('A', () => assert.fail('Unexpected task result'), error => errors.push(error));
  const read = loader.refresh(); loader.stop();
  pending.reject(new Error('old failure'));
  await read; await loader.refresh();
  assert.deepEqual(errors, []);
  assert.equal(fetch.mock.calls.length, 1);
});

test('an active load failure is handled and a later refresh can recover', async () => {
  let calls = 0;
  const failure = new Error('network failure');
  mock.method(googleService, 'getTasks', async () => { if (++calls === 1) throw failure; return [task('recovered')]; });
  const accepted: GoogleTaskRaw[][] = [];
  const errors: unknown[] = [];
  const loader = createGoogleTaskLoader('A', tasks => accepted.push(tasks), error => errors.push(error));
  await loader.refresh(); await loader.refresh();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(accepted, [[task('recovered')]]);
});
