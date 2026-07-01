/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkLog } from '../db.ts';
import { getWorkLogSyncKey, mergeWorkLogSnapshots } from './workLogSyncIdentity.ts';

const baseWorkLog = (overrides: Partial<WorkLog>): WorkLog => ({
    date: '2026-07-01',
    projectId: 1,
    projectName: 'Plaza',
    people: 'Martin',
    hours: 8,
    source: 'voice',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
});

test('mergeWorkLogSnapshots keeps independent desktop and mobile records', () => {
    const desktop = baseWorkLog({
        syncId: 'desktop-a',
        description: 'Desktop diktát',
        createdAt: 100,
        updatedAt: 100,
    });
    const mobile = baseWorkLog({
        syncId: 'mobile-b',
        description: 'Mobilní diktát',
        createdAt: 200,
        updatedAt: 200,
    });

    const merged = mergeWorkLogSnapshots([mobile], [desktop]);

    assert.equal(merged.length, 2);
    assert.deepEqual(
        merged.map((workLog) => workLog.syncId).sort(),
        ['desktop-a', 'mobile-b'],
    );
});

test('mergeWorkLogSnapshots keeps the newest version of the same sync id', () => {
    const local = baseWorkLog({
        syncId: 'shared-id',
        description: 'Starší text',
        updatedAt: 100,
    });
    const cloud = baseWorkLog({
        syncId: 'shared-id',
        description: 'Novější text',
        updatedAt: 200,
    });

    const merged = mergeWorkLogSnapshots([local], [cloud]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].description, 'Novější text');
});

test('legacy sync key falls back to stable creation metadata', () => {
    assert.equal(
        getWorkLogSyncKey(baseWorkLog({ syncId: undefined, createdAt: 123, extractionBatchId: 'voice-1' })),
        'legacy|voice-1|123|2026-07-01|plaza|martin',
    );
});
