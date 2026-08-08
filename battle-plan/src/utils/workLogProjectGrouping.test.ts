/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Project, WorkLog } from '../db.ts';
import { groupWorkLogsByProject } from './workLogProjectGrouping.ts';

test('calendar and table grouping treat normalized WorkLog names as one project', () => {
    const projects: Project[] = [
        { id: 1, name: 'Komerční banka', color: 'indigo', isActive: true, createdAt: 1, updatedAt: 1 },
        { id: 2, name: ' KOMERČNÍ BANKA ', color: 'rose', isActive: false, createdAt: 2, updatedAt: 2 },
    ];
    const names = ['Komerční banka', ' komerční banka ', 'KOMERČNÍ BANKA', 'Komerční banka'];
    const workLogs: WorkLog[] = names.map((projectName, index) => ({
        id: index + 1,
        date: '2026-08-08',
        projectId: index % 2 === 0 ? 1 : 2,
        projectName,
        people: index < 2 ? 'Martin' : 'Petr',
        hours: 1,
        source: 'manual',
        createdAt: 10 + index,
        updatedAt: 10 + index,
    }));

    assert.deepEqual(groupWorkLogsByProject(workLogs, projects), [{
        key: 'komerční banka',
        name: 'Komerční banka',
        color: 'indigo',
        hours: 4,
        count: 4,
        people: ['Martin', 'Petr'],
    }]);
});
