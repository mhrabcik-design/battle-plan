/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../db.ts';
import { readTaskBackupSnapshot } from './taskBackupRevision.ts';
import { filterTaskBackupSettings } from './taskBackupSettings.ts';

test('backup settings allow only portable preferences, never secrets or unknown future settings', () => {
    assert.deepEqual(filterTaskBackupSettings([
        { id: 'gemini_api_key', value: 'synthetic-secret' },
        { id: 'future_token', value: 'synthetic-secret' },
        { id: 'gemini_model', value: 'gemini-model' },
        { id: 'ui_scale', value: '1' },
    ]), [{ id: 'gemini_model', value: 'gemini-model' }, { id: 'ui_scale', value: '1' }]);
});

test('changing a local API key does not change or leak into the backup snapshot', async () => {
    await db.settings.clear();
    const before = await readTaskBackupSnapshot();
    await db.settings.put({ id: 'gemini_api_key', value: 'synthetic-secret' });
    const after = await readTaskBackupSnapshot();
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(after).includes('synthetic-secret'), false);
});
