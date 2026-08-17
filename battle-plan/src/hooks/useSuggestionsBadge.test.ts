/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRegistryErrorLogGate } from '../utils/syncErrorLogGate.ts';

test('registry error logging emits state transitions but suppresses unchanged polling failures', () => {
  const gate = createRegistryErrorLogGate();

  assert.equal(gate.shouldLog('Drive read failed'), true);
  assert.equal(gate.shouldLog('Drive read failed'), false);
  assert.equal(gate.shouldLog('Drive create failed'), true);
  assert.equal(gate.shouldLog('Drive create failed'), false);

  gate.recovered();
  assert.equal(gate.shouldLog('Drive create failed'), true);
});
