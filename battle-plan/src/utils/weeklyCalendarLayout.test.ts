import assert from 'node:assert/strict';
import test from 'node:test';
import type { UnifiedTask } from '../types.ts';
import { getCalendarDensity, getWeeklyVisualInterval, layoutCalendarIntervals } from './weeklyCalendarLayout.ts';

const task = (overrides: Partial<UnifiedTask>): UnifiedTask => ({
  title: 'Položka',
  type: 'task',
  status: 'pending',
  urgency: 2,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test('normalizes meeting start and task end into visual intervals', () => {
  assert.deepEqual(getWeeklyVisualInterval(task({ id: 1, type: 'meeting', startTime: '09:00', duration: 60 })), {
    id: 'l-1', startMinute: 540, endMinute: 600,
  });
  assert.deepEqual(getWeeklyVisualInterval(task({ id: 2, type: 'task', startTime: '11:00', duration: 120 })), {
    id: 'l-2', startMinute: 540, endMinute: 660,
  });
});

test('places overlapping intervals in columns and touching intervals reuse a column', () => {
  const result = layoutCalendarIntervals([
    { id: 'a', startMinute: 540, endMinute: 600 },
    { id: 'b', startMinute: 570, endMinute: 630 },
    { id: 'c', startMinute: 600, endMinute: 660 },
  ], 180);
  assert.deepEqual(result.map(item => [item.id, item.column, item.columnCount]), [
    ['a', 0, 2], ['b', 1, 2], ['c', 0, 2],
  ]);
  assert.equal(result.every(item => item.visible), true);
});

test('cascades dense groups instead of shrinking below the minimum width', () => {
  const result = layoutCalendarIntervals([
    { id: 'a', startMinute: 540, endMinute: 660 },
    { id: 'b', startMinute: 550, endMinute: 650 },
    { id: 'c', startMinute: 560, endMinute: 640 },
  ], 100);
  assert.equal(result.filter(item => item.visible).length, 1);
  assert.equal(result.find(item => item.visible)?.hiddenCount, 2);
});

test('density exposes only content that fits the rendered block', () => {
  assert.equal(getCalendarDensity(40), 'compact');
  assert.equal(getCalendarDensity(48), 'standard');
  assert.equal(getCalendarDensity(72), 'comfortable');
});
