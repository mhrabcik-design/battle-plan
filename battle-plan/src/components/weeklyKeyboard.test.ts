import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { toLocalIsoDate } from '../utils/monthCalendar.ts';
import type { WeeklyDropTarget } from '../utils/calendarUtils.ts';

process.env.TZ = 'Pacific/Kiritimati';

test('real weekly keyboard handler keeps the civil day in UTC+14 when moving and committing', async () => {
    assert.equal(new Date('2026-10-12T12:00:00').toISOString().slice(0, 10), '2026-10-11');
    const source = readFileSync(new URL('./WeeklyCalendar.tsx', import.meta.url), 'utf8');
    const tree = ts.createSourceFile('WeeklyCalendar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration: ts.VariableDeclaration | undefined;
    const find = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleKeyDown') declaration = node;
        ts.forEachChild(node, find);
    };
    find(tree);
    assert.ok(declaration?.initializer, 'keyboard handler exists');
    const executable = ts.transpileModule(`exports.handle = ${declaration.initializer.getText(tree)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const task = { id: 'keyboard-fixture' };
    let target: WeeklyDropTarget = { date: '2026-10-12', lane: 'timed', blockTopMinutes: 9 * 60 };
    let committed: WeeklyDropTarget | null = null;
    let prevented = 0;
    const exports: { handle?: (event: unknown, task: unknown) => Promise<void> } = {};
    runInNewContext(executable, {
        exports, Date, toLocalIsoDate,
        isCalendarReadonly: () => false,
        taskKey: (value: typeof task) => value.id,
        dragRef: { current: { task, pointerId: -1 } },
        get dropTarget() { return target; },
        startHour: 7,
        publishTarget: (_task: unknown, next: WeeklyDropTarget) => { target = next; },
        commitDrop: (_task: unknown, next: WeeklyDropTarget) => { committed = next; },
        keyboardTargetFor: () => { throw new Error('active drag should use its published target'); },
        cancelDrag: () => { throw new Error('unexpected cancellation'); },
    });
    const press = (key: string) => exports.handle!({ key, preventDefault: () => { prevented++; } }, task);
    await press('ArrowRight');
    assert.equal(target.date, '2026-10-13');
    await press('ArrowDown');
    assert.equal(target.date, '2026-10-13');
    assert.equal(target.blockTopMinutes, 9 * 60 + 15);
    await press('ArrowLeft');
    assert.equal(target.date, '2026-10-12');
    await press('Enter');
    assert.equal(committed, target);
    assert.equal(prevented, 4);
});
