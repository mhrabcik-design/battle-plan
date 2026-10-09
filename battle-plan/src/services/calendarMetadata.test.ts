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

test('ambiguous scopes, pairings and simultaneous divergent baselines reject recovery without selecting one', () => {
    for (const changed of [{ accountId: 'b' }, { calendarId: 'other' }, { canonicalIdentity: 'other' }, { eventId: 'wrong' }, { etag: 'different' }]) {
        assert.throws(() => mergeCalendarMetadata([metadata(), metadata(changed)]), /Calendar/);
    }
    assert.throws(() => mergeCalendarMetadata([metadata({ generation: NaN })]), /Calendar/);
    assert.throws(() => mergeCalendarMetadata([metadata({ metadataUpdatedAt: NaN })]), /Calendar/);
});
