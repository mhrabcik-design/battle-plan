import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { db, type Task } from './db.ts';
import { mergeTasksFromDrive } from './services/taskMerge.ts';
import { newTaskMutationContext, TaskMutationService } from './services/taskMutations.ts';

test('App task startup effects preserve old offline deletion through restart and stale import', async () => {
    await db.tasks.clear();
    const deletedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const live: Task = { publicId: 'task_startup_deletion', title: 'Offline deleted', type: 'task', urgency: 1,
        status: 'pending', createdAt: deletedAt - 1000, updatedAt: deletedAt - 1000 };
    const id = await db.tasks.add(live);
    const service = new TaskMutationService(db, { now: () => deletedAt });
    assert.equal((await service.archiveTask({ localId: id, context: newTaskMutationContext('ui') })).status, 'applied');
    await db.close(); await db.open();

    const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const effects: string[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' &&
            node.arguments[0]?.getText(tree).includes('db.tasks') &&
            node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) && node.arguments[1].elements.length === 0) {
            effects.push(node.arguments[0].getText(tree));
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    // Replay actual task-related mount effects, including React's repeated development mount.
    const callbacks = effects.map(effect => runInNewContext(ts.transpileModule(`(${effect})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, { db, Date, console }) as () => void | Promise<void>);
    for (let mount = 0; mount < 2; mount++) {
        for (const callback of callbacks) await callback();
        // Dexie/IndexedDB and fire-and-forget startup callbacks settle across event-loop turns.
        for (let turn = 0; turn < 10; turn++) {
            await db.tasks.count();
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        const marker = await db.tasks.get(id);
        assert.ok(marker, 'startup must retain the deletion marker before any sync');
        assert.equal(marker?.isDeleted, true, 'startup must retain the deletion marker before any sync');
        assert.equal(marker.updatedAt, deletedAt);
    }
    assert.equal(await mergeTasksFromDrive([live]), false);
    assert.equal((await db.tasks.get(id))?.isDeleted, true);
    assert.equal(await db.tasks.count(), 1);
});
