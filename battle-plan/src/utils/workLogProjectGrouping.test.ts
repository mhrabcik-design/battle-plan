/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Project, WorkLog } from '../db.ts';
import {
    createWorkLogProjectIndex,
    groupWorkLogsByProject,
    resolveWorkLogProjectDisplay,
} from './workLogProjectGrouping.ts';

function workLog(projectId: number, projectName: string): WorkLog {
    return {
        id: 99,
        date: '2026-08-08',
        projectId,
        projectName,
        people: 'Martin',
        hours: 2,
        source: 'manual',
        createdAt: 10,
        updatedAt: 10,
    };
}

function ambiguousAliasProjects(): Project[] {
    return [
        {
            id: 7,
            name: 'Komerční Banka',
            aliases: ['Společný projekt'],
            color: 'amber',
            isActive: true,
            createdAt: 1,
            updatedAt: 1,
        },
        {
            id: 8,
            name: 'Plaza Liberec',
            aliases: ['Společný projekt'],
            color: 'emerald',
            isActive: true,
            createdAt: 2,
            updatedAt: 2,
        },
    ];
}

test('display resolver uses the survivor identity for an absorbed snapshot without mutating it', () => {
    const survivor: Project = {
        id: 7,
        name: 'Komerční Banka',
        aliases: ['Komerční banka Plaza'],
        color: 'amber',
        isActive: true,
        createdAt: 1,
        updatedAt: 2,
    };
    const historical = workLog(7, 'Komerční banka Plaza');
    const before = structuredClone(historical);

    assert.deepEqual(
        resolveWorkLogProjectDisplay(historical, createWorkLogProjectIndex([survivor])),
        { name: 'Komerční Banka', color: 'amber' },
    );
    assert.deepEqual(historical, before);
});

test('display resolver uses an unambiguous alias when the absorbed project id is stale', () => {
    const survivor: Project = {
        id: 7,
        name: 'Komerční Banka',
        aliases: ['Komerční banka Plaza'],
        color: 'amber',
        isActive: true,
        createdAt: 1,
        updatedAt: 2,
    };

    assert.deepEqual(
        resolveWorkLogProjectDisplay(
            workLog(404, ' Komerční banka Plaza '),
            createWorkLogProjectIndex([survivor]),
        ),
        { name: 'Komerční Banka', color: 'amber' },
    );
});

test('display resolver rejects an unrelated device-local id collision without a matching identity', () => {
    const unrelated: Project = {
        id: 7,
        name: 'Plaza Liberec',
        color: 'emerald',
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
    };

    const historical = workLog(7, '  Komerční banka Plaza  ');
    const projectIndex = createWorkLogProjectIndex([unrelated]);

    assert.deepEqual(
        resolveWorkLogProjectDisplay(historical, projectIndex),
        { name: 'Komerční banka Plaza', color: 'slate' },
    );
    assert.deepEqual(groupWorkLogsByProject([historical], projectIndex), [{
        key: 'komerční banka plaza',
        name: 'Komerční banka Plaza',
        color: 'slate',
        hours: 2,
        count: 1,
        people: ['Martin'],
    }]);
});

test('display resolver fails closed when an alias has competing owners', () => {
    assert.deepEqual(
        resolveWorkLogProjectDisplay(
            workLog(404, ' Společný projekt '),
            createWorkLogProjectIndex(ambiguousAliasProjects()),
        ),
        { name: 'Společný projekt', color: 'slate' },
    );
});

test('display resolver rejects an id collision when the snapshot alias is also ambiguous', () => {
    assert.deepEqual(
        resolveWorkLogProjectDisplay(
            workLog(7, 'Společný projekt'),
            createWorkLogProjectIndex(ambiguousAliasProjects()),
        ),
        { name: 'Společný projekt', color: 'slate' },
    );
});

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
