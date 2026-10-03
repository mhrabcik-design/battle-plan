/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkLog } from '../db.ts';
import { createLegacyWorkLogSyncId, getWorkLogSyncKey, mergeWorkLogSnapshots, normalizeLegacyWorkLogSnapshots as normalizeWorkLogFiles } from './workLogSyncIdentity.ts';

const normalizeLegacyWorkLogSnapshots = (snapshots: WorkLog[][]) => normalizeWorkLogFiles(
    snapshots.map(workLogs => ({ workLogs, last_updated: Math.max(...workLogs.map(row => row.updatedAt ?? row.createdAt ?? 0)) })),
);

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

test('different legacy public identities preserve identical work across versions and file order', () => {
    const first = baseWorkLog({ publicId: 'worklog_first', hours: 2, updatedAt: 10 });
    const second = { ...first, publicId: 'worklog_second' };
    for (const rows of [[first, second], [second, first]]) {
        const result = mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots([rows, rows]));
        assert.equal(result.length, 2);
        assert.equal(result.reduce((total, row) => total + row.hours, 0), 4);
        assert.equal(new Set(result.map(row => row.syncId)).size, 2);
        const changed = { ...first, hours: 3, updatedAt: 20 };
        const newerRows = rows.map(row => row.publicId === first.publicId ? changed : row);
        for (const snapshots of [[rows, newerRows], [newerRows, rows]]) {
            const versions = mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots(snapshots));
            assert.equal(versions.length, 2);
            assert.equal(versions.reduce((total, row) => total + row.hours, 0), 5);
            for (const row of versions) assert.equal(row.syncId, result.find(original => original.publicId === row.publicId)!.syncId);
        }
    }
});

test('legacy occurrence identities remain compatible with existing deletion tombstones', () => {
    const base = baseWorkLog({ hours: 2, updatedAt: 10 });
    const rows = [{ ...base, id: 1, publicId: 'worklog_z' }, { ...base, id: 2, publicId: 'worklog_a' }];
    const originalId = createLegacyWorkLogSyncId(base);
    const result = mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots([rows]));
    assert.equal(result.find(row => row.publicId === 'worklog_z')!.syncId, originalId);
    const afterDeletion = result.filter(row => row.syncId !== `${originalId}-2`);
    assert.deepEqual(afterDeletion.map(row => row.publicId), ['worklog_z']);
});

test('an anonymous explicit identity is reserved before assigning a legacy public identity', () => {
    const base = baseWorkLog({ hours: 2, updatedAt: 10 });
    const explicit = { ...base, syncId: createLegacyWorkLogSyncId(base) };
    const legacy = { ...base, publicId: 'worklog_known' };
    const result = mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots([[explicit, legacy]]));
    assert.equal(result.length, 2);
    assert.equal(result.reduce((sum, row) => sum + row.hours, 0), 4);
});

test('mixed legacy occurrence order remains compatible with earlier tombstones', () => {
    const base = baseWorkLog({ hours: 2, updatedAt: 10 });
    const identified = { ...base, publicId: 'worklog_second' };
    const originalId = createLegacyWorkLogSyncId(base);
    const result = mergeWorkLogSnapshots([], normalizeLegacyWorkLogSnapshots([[base, identified]]));
    assert.equal(result.find(row => row.publicId)!.syncId, `${originalId}-2`);
    assert.deepEqual(result.filter(row => row.syncId !== originalId).map(row => row.publicId), ['worklog_second']);
});

test('a later stale-device upload cannot reassign the original deleted legacy version', () => {
    const old = baseWorkLog({ publicId: 'worklog_stale_upload', hours: 1, updatedAt: 10 });
    const edited = { ...old, hours: 3, updatedAt: 20 };
    const files = [{ workLogs: [edited], last_updated: 25 }, { workLogs: [old], last_updated: 30 }];
    const deletedId = createLegacyWorkLogSyncId(old);
    const restored = normalizeWorkLogFiles(files).filter(row => row.syncId !== deletedId);
    assert.deepEqual(mergeWorkLogSnapshots([], restored), []);
});

test('ambiguous historical occurrence reordering stops import instead of guessing deletion identity', () => {
    const first = baseWorkLog({ publicId: 'first', updatedAt: 10 });
    const second = { ...first, publicId: 'second' };
    assert.throws(() => normalizeLegacyWorkLogSnapshots([[first, second], [second, first]]), /konflikt/i);
});
