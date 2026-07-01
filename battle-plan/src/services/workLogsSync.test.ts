/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkLogsFileMetadata } from './workLogsDriveMetadata.ts';

test('buildWorkLogsFileMetadata puts a new file into the BattlePlan Drive folder', () => {
    assert.deepEqual(
        buildWorkLogsFileMetadata('folder-123', null),
        {
            name: 'work_logs_data.json',
            mimeType: 'application/json',
            parents: ['folder-123'],
        },
    );
});

test('buildWorkLogsFileMetadata does not move existing Drive files on update', () => {
    assert.deepEqual(
        buildWorkLogsFileMetadata('folder-123', 'file-456'),
        {
            name: 'work_logs_data.json',
            mimeType: 'application/json',
        },
    );
});
