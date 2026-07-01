/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { getMissingWorkLogsFileStatus, hasLocalWorkLogsData } from './workLogsSyncStatus.ts';

test('missing WorkLogs file is idle when there is no local work data yet', () => {
    assert.equal(hasLocalWorkLogsData({ workLogs: 0, projects: 0 }), false);
    assert.deepEqual(
        getMissingWorkLogsFileStatus({ workLogs: 0, projects: 0 }),
        {
            state: 'idle',
            detail: 'Čeká na první pracovní záznam',
        },
    );
});

test('missing WorkLogs file is stale when local work data needs upload', () => {
    assert.equal(hasLocalWorkLogsData({ workLogs: 1, projects: 0 }), true);
    assert.deepEqual(
        getMissingWorkLogsFileStatus({ workLogs: 1, projects: 0 }),
        {
            state: 'stale',
            detail: 'WorkLogs soubor zatím neexistuje, vytvářím zálohu',
        },
    );
});
