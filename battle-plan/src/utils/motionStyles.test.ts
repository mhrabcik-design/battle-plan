import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

test('exit-retained overlay controls are inert before portal teardown', () => {
  const overlay = readFileSync(new URL('../components/ui/OverlaySurface.tsx', import.meta.url), 'utf8');
  assert.match(overlay, /const isPresent = useIsPresent\(\)/);
  assert.match(overlay, /inert=\{!isPresent\}/);
  assert.match(overlay, /pointerEvents: isPresent \? undefined : 'none'/);
});

test('primary controls explicitly transition individual transform properties', () => {
  const primary = css.match(/\.office-button-primary\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(primary, /translate var\(--motion-quick\)/);
  assert.match(primary, /scale var\(--motion-quick\)/);
  assert.doesNotMatch(primary, /active:scale-95|hover:-translate/);
});

test('press feedback is limited to enabled controls', () => {
  assert.match(css, /\.surface-action:not\(:disabled\):not\(\[aria-disabled="true"\]\):active/);
  assert.match(css, /\.office-button-primary:not\(:disabled\):not\(\[aria-disabled="true"\]\):active/);
});

test('reduced motion suppresses spatial control feedback without resetting all layout transforms', () => {
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.office-button-primary,\s*\.office-btn-ghost,\s*\.surface-action\s*\{[^}]*transform: none !important;[^}]*translate: none !important;[^}]*scale: none !important;/);
  const universal = reduced.match(/\*::after\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.doesNotMatch(universal, /transform:|translate:|scale:/);
});
