import assert from 'node:assert/strict';
import test from 'node:test';
import type { UnifiedTask } from '../types.ts';
import {
    ACTIVE_TASK_TITLE_CLASSES,
    COMPLETED_TASK_CARD_CLASSES,
    COMPLETED_TASK_TITLE_CLASSES,
    getTaskCompletionClasses,
    getTaskGridPresentation,
    getTaskListPresentation,
    LEGACY_COMPLETED_CARD_CLASSES,
    sortTasksActiveFirst,
} from './taskListPresentation.ts';

const task = (title: string, status: UnifiedTask['status'], urgency: UnifiedTask['urgency']): UnifiedTask => ({
    title,
    status,
    urgency,
    type: 'task',
    createdAt: 1,
    updatedAt: 1,
});

test('completed tasks are hidden by default and can be explicitly included', () => {
    const tasks = [
        task('Active', 'pending', 2),
        task('Completed', 'completed', 3),
    ];

    const defaultPresentation = getTaskListPresentation(tasks);
    const expandedPresentation = getTaskListPresentation(tasks, true);

    assert.equal(defaultPresentation.completedTaskCount, 1);
    assert.deepEqual(defaultPresentation.visibleTasks.map(item => item.title), ['Active']);
    assert.deepEqual(expandedPresentation.visibleTasks.map(item => item.title), ['Active', 'Completed']);
    assert.equal(expandedPresentation.visibleTasks, tasks);
});

test('completed-task filtering applies only to the Tasks view', () => {
    const tasks = [task('Active', 'pending', 2), task('Completed', 'completed', 3)];

    assert.deepEqual(getTaskGridPresentation(tasks, 'tasks').visibleTasks, [tasks[0]]);
    assert.equal(getTaskGridPresentation(tasks, 'tasks', true).visibleTasks, tasks);

    for (const viewMode of ['battle', 'week', 'meetings', 'thoughts'] as const) {
        const presentation = getTaskGridPresentation(tasks, viewMode);
        assert.equal(presentation.visibleTasks, tasks);
        assert.equal(presentation.completedTaskCount, 0);
    }
});

test('emerald completed styling is scoped to the Tasks view treatment', () => {
    assert.deepEqual(getTaskCompletionClasses(true, true), {
        card: COMPLETED_TASK_CARD_CLASSES,
        title: COMPLETED_TASK_TITLE_CLASSES,
    });
    assert.deepEqual(getTaskCompletionClasses(true, false), {
        card: LEGACY_COMPLETED_CARD_CLASSES,
        title: ACTIVE_TASK_TITLE_CLASSES,
    });
    assert.deepEqual(getTaskCompletionClasses(false, true), {
        card: '',
        title: ACTIVE_TASK_TITLE_CLASSES,
    });
});

test('active tasks are sorted before completed tasks while preserving urgency order in each group', () => {
    const tasks = [
        task('Completed urgent', 'completed', 3),
        task('Active normal', 'pending', 2),
        task('Completed low', 'completed', 1),
        task('Active urgent', 'pending', 3),
    ];

    assert.deepEqual(sortTasksActiveFirst(tasks).map(item => item.title), [
        'Active urgent',
        'Active normal',
        'Completed urgent',
        'Completed low',
    ]);
    assert.equal(tasks[0]?.title, 'Completed urgent');
});
