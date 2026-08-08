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
        key: 'project-id:1',
        name: 'Komerční banka',
        color: 'indigo',
        hours: 4,
        count: 4,
        people: ['Martin', 'Petr'],
    }]);
});

test('manual-merge aliases group historical snapshots under the survivor identity', () => {
    const survivor: Project = {
        id: 7,
        name: 'Komerční Banka',
        aliases: ['Komerční banka Plaza'],
        color: 'amber',
        isActive: true,
        createdAt: 1,
        updatedAt: 2,
    };
    const snapshots = [
        { name: 'Komerční Banka', people: 'Martin', hours: 2 },
        { name: 'Komerční Banka', people: 'Petr', hours: 3 },
        { name: 'Komerční Banka', people: 'Martin, Sergej', hours: 4 },
        { name: 'Komerční banka Plaza', people: 'Sergej', hours: 1.5 },
    ];
    const workLogs: WorkLog[] = snapshots.map((snapshot, index) => ({
        id: index + 1,
        date: '2026-08-08',
        projectId: survivor.id!,
        projectName: snapshot.name,
        people: snapshot.people,
        hours: snapshot.hours,
        source: 'manual',
        createdAt: 10 + index,
        updatedAt: 10 + index,
    }));

    assert.deepEqual(groupWorkLogsByProject(workLogs, [survivor]), [{
        key: 'project-id:7',
        name: 'Komerční Banka',
        color: 'amber',
        hours: 10.5,
        count: 4,
        people: ['Martin', 'Petr', 'Sergej'],
    }]);
    assert.deepEqual(
        workLogs.map((workLog) => workLog.projectName),
        ['Komerční Banka', 'Komerční Banka', 'Komerční Banka', 'Komerční banka Plaza'],
        'grouping must not rewrite historical snapshots',
    );
});
