/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Project } from '../../db.ts';
import {
    getProjectMergeEligibility,
    projectMergeErrorMessage,
} from './projectMergeUi.ts';

const projects: Project[] = [
    { id: 1, name: 'Komerční Banka', color: 'amber', isActive: true, createdAt: 1, updatedAt: 1 },
    { id: 2, name: 'Komerční banka Plaza', color: 'indigo', isActive: true, createdAt: 2, updatedAt: 2 },
    { id: 3, name: 'Plaza Liberec', color: 'emerald', isActive: false, createdAt: 3, updatedAt: 3 },
];

test('U4: merge selector allows archived source but only distinct active survivor', () => {
    const eligibility = getProjectMergeEligibility(projects, 3);

    assert.deepEqual(eligibility.sourceProjects.map((project) => project.id), [1, 2, 3]);
    assert.deepEqual(eligibility.survivorProjects.map((project) => project.id), [1, 2]);
    assert.equal(eligibility.disabledReason, null);
});

test('U4: merge selector explains when no active survivor is available', () => {
    const eligibility = getProjectMergeEligibility([
        { ...projects[0], isActive: false },
        { ...projects[1], isActive: false },
    ], 1);

    assert.deepEqual(eligibility.survivorProjects, []);
    assert.equal(eligibility.disabledReason, 'Nejdřív obnov alespoň jeden jiný projekt, který má po sloučení zůstat aktivní.');
});

test('U4: all-archived catalog explains the missing active survivor before source selection', () => {
    const eligibility = getProjectMergeEligibility([
        { ...projects[0], isActive: false },
        { ...projects[1], isActive: false },
    ]);

    assert.equal(eligibility.disabledReason, 'Nejdřív obnov alespoň jeden jiný projekt, který má po sloučení zůstat aktivní.');
});

test('U4: stale and conflict outcomes have precise Czech recovery messages', () => {
    assert.equal(
        projectMergeErrorMessage({ outcome: 'stale', message: 'project identity changed after preview' }),
        'Vybrané projekty se od náhledu změnily. Zkontroluj je a vytvoř nový náhled sloučení.',
    );
    assert.equal(
        projectMergeErrorMessage({ outcome: 'conflict', projects: [projects[2]] }),
        'Sloučení blokuje konflikt identity s projektem „Plaza Liberec“. Nic se nezměnilo.',
    );
});
