import test from 'node:test';
import assert from 'node:assert/strict';
import { createPwaUpdateConsent } from './pwaUpdateConsent.ts';

test('a waiting update never activates or reloads without explicit consent', () => {
  let activations = 0;
  let reloads = 0;
  const update = createPwaUpdateConsent(() => activations++, () => reloads++);
  assert.equal(activations, 0);
  assert.equal(reloads, 0);
  update.accept();
  assert.equal(activations, 1);
  assert.equal(reloads, 0);
  update.controlling();
  assert.equal(reloads, 1);
});

test('activation in another tab does not reload this tab until it consents', () => {
  let activations = 0;
  let reloads = 0;
  const update = createPwaUpdateConsent(() => activations++, () => reloads++);
  update.controlling();
  assert.equal(reloads, 0);
  update.accept();
  assert.equal(activations, 0);
  assert.equal(reloads, 1);
});
