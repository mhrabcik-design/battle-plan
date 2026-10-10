import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { db } from './db.ts';
import { getWeekDays } from './utils/calendarUtils.ts';
import { toLocalIsoDate } from './utils/monthCalendar.ts';
import { isTaskVisibleInWeek } from './utils/taskHistory.ts';

process.env.TZ = 'Europe/Prague';
after(() => db.close());

test('actual App clock, memo, live-query dependencies and weekly props advance together', async () => {
    await db.tasks.clear();
    const common = { type: 'task' as const, status: 'pending' as const, urgency: 2 as const, createdAt: 1, updatedAt: 1 };
    await db.tasks.bulkAdd([
        { ...common, title: 'Sunday', deadline: '2026-10-11' },
        { ...common, title: 'Monday', deadline: '2026-10-12' },
    ]);
    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const bindings = new Map<string, string>();
    let gridDays: string | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ['today', 'weekDays', 'localTasks'].includes(node.name.getText(tree)) && node.initializer) {
            bindings.set(node.name.getText(tree), node.initializer.getText(tree));
        }
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'WeeklyCalendar') {
            const attribute = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(tree) === 'days');
            assert.ok(attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer));
            gridDays = attribute.initializer.expression?.getText(tree);
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(bindings.size, 3);
    assert.ok(gridDays, 'calendar receives explicit days');
    const code = ts.transpileModule(`exports.render = () => {
        ${['today', 'weekDays', 'localTasks'].map(name => `const ${name} = ${bindings.get(name)};`).join('\n')}
        return { days: ${gridDays}, tasks: localTasks };
    };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    let currentTime = new Date(2026, 9, 11, 23, 59);
    let memo: { deps: unknown[]; value: ReturnType<typeof getWeekDays> } | undefined;
    let query: { deps: unknown[]; value: Promise<unknown> } | undefined;
    const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    let reads = 0;
    const exports: { render?: () => { days: ReturnType<typeof getWeekDays>; tasks: Promise<{ title: string }[]> } } = {};
    runInNewContext(code, {
        exports, Date, db, toLocalIsoDate, getWeekDays, isTaskVisibleInWeek,
        get currentTime() { return currentTime; },
        weekOffset: 0, viewMode: 'week', TASK_QUERY_VIEW_MODES: ['week'], EMPTY_TASKS: [],
        useMemo: (callback: () => ReturnType<typeof getWeekDays>, deps: unknown[]) => {
            if (!memo || !same(memo.deps, deps)) memo = { deps, value: callback() };
            return memo.value;
        },
        useLiveQuery: (callback: () => Promise<unknown>, deps: unknown[]) => {
            if (!query || !same(query.deps, deps)) { reads++; query = { deps, value: callback() }; }
            return query.value;
        },
    });
    let result = exports.render!();
    assert.equal(result.days[0].full, '2026-10-05');
    assert.equal(result.days.find(day => day.isToday)?.full, '2026-10-11');
    assert.deepEqual((await result.tasks).map(task => task.title), ['Sunday']);
    currentTime = new Date(2026, 9, 12, 0, 1);
    result = exports.render!();
    assert.equal(result.days[0].full, '2026-10-12');
    assert.equal(result.days.find(day => day.isToday)?.full, '2026-10-12');
    assert.deepEqual((await result.tasks).map(task => task.title), ['Monday']);
    assert.equal(reads, 2);
    currentTime = new Date(2026, 9, 13, 0, 1);
    result = exports.render!();
    assert.equal(result.days.find(day => day.isToday)?.full, '2026-10-13');
    assert.deepEqual((await result.tasks).map(task => task.title), ['Monday']);
    assert.equal(reads, 2, 'midnight within the same week keeps the same database query');
});
