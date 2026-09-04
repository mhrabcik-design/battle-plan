import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThemePreference, persistThemePreference, readThemePreference, resolveTheme } from './themePreference.ts';

test('parseThemePreference accepts explicit themes and defaults everything else to system', () => {
  assert.equal(parseThemePreference('light'), 'light');
  assert.equal(parseThemePreference('dark'), 'dark');
  assert.equal(parseThemePreference(null), 'system');
  assert.equal(parseThemePreference('sepia'), 'system');
});

test('storage method failures safely fall back without throwing', () => {
  const deniedRead = { getItem: () => { throw new Error('denied'); } };
  const deniedWrite = {
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(readThemePreference(deniedRead), 'system');
  assert.doesNotThrow(() => persistThemePreference('dark', deniedWrite));
  assert.doesNotThrow(() => persistThemePreference('system', deniedWrite));
});

test('resolveTheme follows the OS only for system preference', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});
