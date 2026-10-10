import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { db, type Project, type WorkLog } from '../../db.ts';
import { addWorkLogWithActiveProject, ProjectUnavailableError } from '../../services/workLogPersistence.ts';
import { getErrorMessage } from '../../utils/errors.ts';
import { toLocalIsoDate } from '../../utils/monthCalendar.ts';
import { getWorkLogRowIssues, parseDecimalHours } from '../../utils/workLogBatch.ts';
import { createWorkLogSyncId } from '../../utils/workLogSyncIdentity.ts';

process.env.TZ = 'Europe/Prague';
const localMidnight = new Date(2026, 9, 9, 0, 30).getTime();
class FormDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? localMidnight : value); }
}

interface Node {
    type: unknown;
    props: Record<string, unknown> & { children: unknown[] };
}
const allNodes = (node: unknown): Node[] => {
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const element = node as Node;
    return [element, ...element.props.children.flatMap(allNodes)];
};
const content = (node: unknown): string => typeof node === 'string' ? node
    : allNodes(node).flatMap(element => element.props.children.filter(child => typeof child === 'string')).join(' ');

function form() {
    const states: unknown[] = [];
    let cursor = 0;
    const saved: WorkLog[] = [];
    const exports: { WorkLogForm?: (props: { onSaved: (log: WorkLog) => void }) => Node } = {};
    const source = readFileSync(new URL('./WorkLogForm.tsx', import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '');
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React, jsxFactory: 'createElement',
    } }).outputText;
    runInNewContext(compiled, {
        exports, Date: FormDate, createWorkLogSyncId, addWorkLogWithActiveProject,
        ProjectUnavailableError, getErrorMessage, getWorkLogRowIssues, parseDecimalHours, toLocalIsoDate,
        Save: 'Save', X: 'X', Plus: 'Plus', ProjectPicker: 'ProjectPicker', useId: () => 'work-log-form',
        createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node =>
            ({ type, props: { ...props, children } }),
        useState: (initial: unknown) => {
            const index = cursor++;
            if (!(index in states)) states[index] = initial;
            return [states[index], (next: unknown) => { states[index] = next; }];
        },
    });
    const render = () => {
        cursor = 0;
        return exports.WorkLogForm!({ onSaved: log => saved.push(log) });
    };
    const find = (predicate: (node: Node) => boolean) => {
        const node = allNodes(render()).find(predicate);
        assert.ok(node, 'expected form element exists');
        return node;
    };
    return {
        saved, render,
        date: () => find(node => node.type === 'input' && node.props.type === 'date'),
        change: (type: string, value: string) => {
            const input = find(node => node.type === 'input' && node.props.type === type);
            (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
        },
        selectProject: (project: Project) => {
            (find(node => node.type === 'ProjectPicker').props.onSelect as (project: Project) => void)(project);
        },
        save: () => (find(node => node.type === 'button' && Boolean(node.props.onClick) &&
            content(node).includes('Uložit činnost')).props.onClick as () => Promise<void>)(),
    };
}

beforeEach(async () => { await db.workLogs.clear(); await db.projects.clear(); });
after(() => db.close());
async function selectedForm() {
    const project: Project = { name: 'Plaza', color: 'slate', isActive: true, createdAt: 1, updatedAt: 1 };
    project.id = await db.projects.add(project);
    const ui = form();
    ui.selectProject(project);
    ui.change('number', '8,5');
    return ui;
}

test('manual date value and maximum are the local day at Prague 00:30', () => {
    assert.equal(new FormDate().toISOString().slice(0, 10), '2026-10-08', 'fixture crosses the UTC day boundary');
    const date = form().date();
    assert.equal(date.props.value, '2026-10-09');
    assert.equal(date.props.max, '2026-10-09');
});

test('real manual save rejects blank, impossible and future dates without writing storage', async () => {
    const ui = await selectedForm();
    for (const date of ['', '2026-02-29', '2026-02-30', '2026-10-10']) {
        ui.change('date', date);
        await ui.save();
        assert.equal(await db.workLogs.count(), 0, date);
        assert.equal(ui.saved.length, 0, date);
        assert.match(content(ui.render()), /datum|budoucnost/i);
    }
});

test('real manual save preserves current, past and leap dates, optional people and decimal comma hours', async () => {
    const ui = await selectedForm();
    for (const date of ['2026-10-09', '2026-10-08', '2024-02-29']) {
        ui.change('date', date);
        ui.change('number', '8,5');
        await ui.save();
    }
    const logs = await db.workLogs.toArray();
    assert.deepEqual(logs.map(log => log.date), ['2026-10-09', '2026-10-08', '2024-02-29']);
    assert.ok(logs.every(log => log.hours === 8.5 && log.people === '' && log.source === 'manual'));
    assert.equal(ui.saved.length, 3);
});

test('manual save still requires a project and positive hours no greater than 24', async () => {
    const empty = form();
    empty.change('number', '8');
    await empty.save();
    assert.equal(await db.workLogs.count(), 0);
    const ui = await selectedForm();
    for (const hours of ['', '0', '-1', '25', 'Infinity']) {
        ui.change('number', hours);
        await ui.save();
        assert.equal(await db.workLogs.count(), 0, hours);
    }
    ui.change('number', '24');
    await ui.save();
    assert.equal((await db.workLogs.toArray())[0].hours, 24);
});
