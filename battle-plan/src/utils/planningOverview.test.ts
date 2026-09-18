import assert from 'node:assert/strict';
import test from 'node:test';
import type { UnifiedTask } from '../types.ts';
import { filterPlanningTasks, getPlanningSummary, createTaskDraft } from './planningOverview.ts';

const task = (patch: Partial<UnifiedTask>): UnifiedTask => ({
  title: 'Úkol', type: 'task', status: 'pending', urgency: 2, createdAt: 1, updatedAt: 1, ...patch,
});
const today = '2026-09-18';
const tasks = [
  task({ title: 'Příprava rozpočtu', deadline: today, date: '2026-09-17' }),
  task({ title: 'Porada', type: 'meeting', date: today, deadline: '2026-09-20' }),
  task({ title: 'Včera', deadline: '2026-09-17' }),
  task({ title: 'Později', deadline: '2026-09-20', subTasks: [{ id: 'a', title: 'Přehled činností', completed: false }] }),
  task({ title: 'Bez termínu', description: 'Nápad na příští měsíc' }),
  task({ title: 'Hotovo', status: 'completed', deadline: '2026-09-17' }),
  task({ title: 'Smazáno', isDeleted: true, deadline: today }),
  task({ title: 'Zrušeno', status: 'cancelled', deadline: today }),
];

test('overview counts open work by its domain date without mutating input', () => {
  const snapshot = JSON.stringify(tasks);
  assert.deepEqual(getPlanningSummary(tasks, today), { all: 5, today: 2, overdue: 1, undated: 1 });
  assert.equal(JSON.stringify(tasks), snapshot);
  assert.deepEqual(filterPlanningTasks(tasks, '', 'today', today).map(t => t.title), ['Příprava rozpočtu', 'Porada']);
  assert.deepEqual(filterPlanningTasks(tasks, '', 'overdue', today).map(t => t.title), ['Včera']);
  assert.deepEqual(filterPlanningTasks(tasks, '', 'undated', today).map(t => t.title), ['Bez termínu']);
});

test('scoped search matches Czech titles, description and subtasks, ignoring case and accents', () => {
  assert.deepEqual(filterPlanningTasks(tasks, '  PRIPRAVA  ', 'all', today).map(t => t.title), ['Příprava rozpočtu']);
  assert.deepEqual(filterPlanningTasks(tasks, 'pristi mesic', 'all', today).map(t => t.title), ['Bez termínu']);
  assert.deepEqual(filterPlanningTasks(tasks, 'PREHLED cinnosti', 'all', today).map(t => t.title), ['Později']);
  assert.equal(filterPlanningTasks(tasks, 'priprava', 'overdue', today).length, 0);
  assert.equal(filterPlanningTasks(tasks, 'neexistuje', 'all', today).length, 0);
  assert.equal(filterPlanningTasks(tasks, 'hotovo', 'all', today).length, 1);
  assert.equal(filterPlanningTasks(tasks, 'smazano', 'all', today).length, 0);
});

test('new drafts are local and unpersisted with the type and local date of their view', () => {
  const now = new Date(2026, 8, 18, 23, 55);
  for (const view of ['battle', 'tasks', 'meetings', 'thoughts'] as const) {
    const draft = createTaskDraft(view, now);
    assert.equal(draft.id, undefined);
    assert.equal(draft.title, '');
    assert.equal(draft.status, 'pending');
    assert.equal(draft.type, view === 'meetings' ? 'meeting' : view === 'thoughts' ? 'thought' : 'task');
    assert.equal(draft.date, view === 'meetings' ? today : undefined);
    assert.equal(draft.createdAt, now.getTime());
  }
});
