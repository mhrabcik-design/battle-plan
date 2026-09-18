/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppContext } from './appContext.ts';
import { buildAppContext, renderAppContextSection } from './appContext.ts';
import { db } from '../db.ts';

test('agent app context exposes absorbed aliases beside the canonical project id', () => {
    const context: AppContext = {
        activeProjects: [{
            id: 7,
            name: 'Komerční Banka',
            aliases: ['Komerční banka Plaza'],
            color: 'amber',
        }],
        archivedProjects: [],
        todaysWorklogs: [],
        config: { model: 'model', uiScale: 16, locale: 'cs-CZ' },
    };

    const rendered = renderAppContextSection(context);

    assert.match(rendered, /Komerční Banka \(id=7, barva=amber, aliasy=Komerční banka Plaza\)/);
});

test('today context reads only the date index and retains the first ten primary keys', async () => {
    await db.workLogs.clear();
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    for (const id of [22, 2, 18, 4, 16, 6, 14, 8, 12, 10, 20, 24]) {
        await db.workLogs.add({ id, date: today, projectId: 1, projectName: `P${id}`, people: '', hours: id, source: 'manual', createdAt: 1, updatedAt: 1 });
    }
    await db.workLogs.add({ id: 1, date: '2000-01-01', projectId: 1, projectName: 'History', people: '', hours: 9, source: 'manual', createdAt: 1, updatedAt: 1 });
    const original = db.workLogs.toArray;
    db.workLogs.toArray = () => { throw new Error('Full-table WorkLogs read'); };
    try {
        const context = await buildAppContext();
        assert.deepEqual(context.todaysWorklogs.map((row) => row.id), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    } finally {
        db.workLogs.toArray = original;
        await db.workLogs.clear();
    }
});
