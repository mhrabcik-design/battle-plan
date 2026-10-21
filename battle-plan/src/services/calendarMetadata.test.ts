import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskCalendarMetadata } from './calendarModel.ts';
import { mergeCalendarMetadata } from './calendarMetadata.ts';

const metadata = (changes: Partial<TaskCalendarMetadata> = {}): TaskCalendarMetadata => ({ accountId: 'a', calendarId: 'primary', eventId: 'e0', canonicalIdentity: 'public:task', origin: 'local', generation: 0, metadataUpdatedAt: 1, ...changes });

test('suppression is monotonic within a generation, while explicit new generation wins in either listing order', () => {
    const suppressed = metadata({ suppressed: true, metadataUpdatedAt: 2 });
    const staleUncancelled = metadata({ metadataUpdatedAt: 3 });
    assert.equal(mergeCalendarMetadata([suppressed, staleUncancelled])?.suppressed, true);
    const restored = metadata({ generation: 1, eventId: 'e1', metadataUpdatedAt: 4 });
    for (const values of [[suppressed, staleUncancelled, restored], [restored, staleUncancelled, suppressed]]) {
        assert.deepEqual(mergeCalendarMetadata(values), restored);
    }
});

test('a newer stale backup cannot reconnect a retained Calendar duplicate in either merge order', () => {
    const detached = metadata({ duplicateOf: 'task_owner', suppressed: true, metadataUpdatedAt: 2 });
    const stale = metadata({ suppressed: false, metadataUpdatedAt: 3 });
    for (const values of [[detached, stale], [stale, detached]]) {
        const merged = mergeCalendarMetadata(values);
        assert.equal(merged?.duplicateOf, 'task_owner');
        assert.equal(merged?.suppressed, true);
        assert.equal(merged?.metadataUpdatedAt, 3);
    }
});

test('conflicting duplicate owners and malformed duplicate markers reject Calendar recovery', () => {
    const detached = metadata({ duplicateOf: 'task_owner', suppressed: true, metadataUpdatedAt: 2 });
    assert.throws(() => mergeCalendarMetadata([detached,
        metadata({ duplicateOf: 'task_other_owner', suppressed: true, metadataUpdatedAt: 3 })]), /Calendar/);
    for (const duplicateOf of ['', 42, null, {}]) {
        assert.throws(() => mergeCalendarMetadata([metadata({ duplicateOf: duplicateOf as string })]), /Calendar/);
    }
});

test('ambiguous scopes, pairings and simultaneous divergent baselines reject recovery without selecting one', () => {
    for (const changed of [{ accountId: 'b' }, { calendarId: 'other' }, { canonicalIdentity: 'other' }, { eventId: 'wrong' }, { etag: 'different' }]) {
        assert.throws(() => mergeCalendarMetadata([metadata(), metadata(changed)]), /Calendar/);
    }
    assert.throws(() => mergeCalendarMetadata([metadata({ generation: NaN })]), /Calendar/);
    assert.throws(() => mergeCalendarMetadata([metadata({ metadataUpdatedAt: NaN })]), /Calendar/);
});
