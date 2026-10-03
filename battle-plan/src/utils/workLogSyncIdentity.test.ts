/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkLog } from '../db.ts';
import { createLegacyWorkLogSyncId, getWorkLogSyncKey, mergeWorkLogSnapshots, normalizeLegacyWorkLogSnapshots } from './workLogSyncIdentity.ts';

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

test('equal-version WorkLog copies ignore device-local identifiers but reject different work', () => {
    const first = baseWorkLog({ syncId: 'same', id: 1, projectId: 1, publicId: 'worklog_a' });
    const copy = { ...first, id: 20, projectId: 30, publicId: 'worklog_b' };
    assert.equal(mergeWorkLogSnapshots([first], [copy]).length, 1);
    for (const rows of [[first, { ...copy, hours: 3 }], [{ ...copy, hours: 3 }, first]]) {
        assert.throws(() => mergeWorkLogSnapshots([], rows), /conflict|konflikt/i);
    }
});

test('a newer WorkLog version resolves an older conflict regardless of snapshot order', () => {
    const first = baseWorkLog({ syncId: 'same', updatedAt: 10, hours: 1 });
    const conflict = { ...first, hours: 2 };
    const latest = { ...first, updatedAt: 20, hours: 3 };
    for (const rows of [[first, conflict, latest], [latest, conflict, first], [conflict, latest, first]]) {
        assert.deepEqual(mergeWorkLogSnapshots([], rows), [latest]);
    }
});

test('legacy versions use an order-independent original identity and reject tied changes', () => {
    const old = baseWorkLog({ publicId: 'worklog_legacy', updatedAt: 10, hours: 1 });
    const changed = { ...old, updatedAt: 20, hours: 2 };
    for (const snapshots of [[[old], [changed]], [[changed], [old]]]) {
        const [winner] = mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots(snapshots));
        assert.equal(winner.hours, 2);
        assert.equal(winner.syncId, createLegacyWorkLogSyncId(old));
    }
    const tied = { ...old, hours: 2 };
    for (const snapshots of [[[old], [tied]], [[tied], [old]]]) {
        assert.throws(() => mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots(snapshots)), /konflikt/i);
    }
});

test('published portable identity anchors legacy copies without joining conflicting identities', () => {
    const old = baseWorkLog({ publicId: 'worklog_legacy', updatedAt: 10, hours: 1 });
    const published = { ...old, syncId: 'already-published', updatedAt: 20, hours: 2 };
    for (const snapshots of [[[old], [published]], [[published], [old]]]) {
        assert.deepEqual(mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots(snapshots)), [published]);
    }
    assert.throws(() => normalizeLegacyWorkLogSnapshots([[published], [{ ...published, syncId: 'different' }]]), /konflikt/i);
});

test('legacy rows with and without a public identity remain separate occurrences in one snapshot', () => {
    const anonymous = baseWorkLog({});
    const identified = { ...anonymous, publicId: 'worklog_identified' };
    for (const rows of [[anonymous, identified], [identified, anonymous]]) {
        const result = normalizeLegacyWorkLogSnapshots([rows, rows]);
        assert.equal(mergeWorkLogSnapshots([], result).length, 2);
    }
});
