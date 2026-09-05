import test from 'node:test';
import assert from 'node:assert/strict';
import { getOverlayMotion } from './overlayMotion.ts';

test('dialog enters gently and exits faster with a tween, not a spring', () => {
  const { panel } = getOverlayMotion('dialog', false);
  assert.deepEqual(panel.initial, { opacity: 0, y: 12, scale: 0.985 });
  assert.deepEqual(panel.animate, { opacity: 1, y: 0, scale: 1 });
  assert.equal(panel.transition.type, 'tween');
  assert.ok(panel.transition.duration <= 0.24);
  assert.ok(panel.exit.transition.duration < panel.transition.duration);
});

test('sheet keeps its short directional entrance and exit', () => {
  const { panel } = getOverlayMotion('sheet', false);
  assert.deepEqual(panel.initial, { opacity: 0, x: 24 });
  assert.deepEqual(panel.animate, { opacity: 1, x: 0 });
  assert.equal(panel.exit.x, 18);
});

test('reduced motion fades both variants without any spatial transforms', () => {
  for (const variant of ['dialog', 'sheet'] as const) {
    const { panel } = getOverlayMotion(variant, true);
    assert.deepEqual(panel.initial, { opacity: 0 });
    assert.deepEqual(panel.animate, { opacity: 1 });
    assert.deepEqual(Object.keys(panel.exit).sort(), ['opacity', 'transition']);
    assert.equal(panel.exit.opacity, 0);
    assert.ok(panel.transition.duration <= 0.12);
  }
});

test('backdrop has an independent opacity-only animation in every mode', () => {
  for (const variant of ['dialog', 'sheet'] as const) {
    for (const reduced of [false, true]) {
      const { backdrop, panel } = getOverlayMotion(variant, reduced);
      assert.deepEqual(backdrop.initial, { opacity: 0 });
      assert.deepEqual(backdrop.animate, { opacity: 1 });
      assert.deepEqual(Object.keys(backdrop.exit).sort(), ['opacity', 'transition']);
      assert.ok(backdrop.exit.transition.duration <= panel.transition.duration);
    }
  }
});
