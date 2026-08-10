/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProtocolPollingCoordinator } from './pollingCoordinator.ts';

test('overlapping local triggers share one in-flight polling promise', async () => {
    const coordinator = createProtocolPollingCoordinator();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = async () => {
        calls += 1;
        await gate;
    };

    const runs = Array.from({ length: 10 }, () => coordinator.run('receiver-a', work));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all(runs), Array(10).fill(undefined));
});

test('Web Lock is only an optimization around the shared-promise boundary', async () => {
    const requests: string[] = [];
    const coordinator = createProtocolPollingCoordinator({
        request: async (name: string, callback: () => Promise<void>) => {
            requests.push(name);
            return callback();
        },
    });
    assert.equal(await coordinator.run('receiver-a', async () => undefined), undefined);
    assert.deepEqual(requests, ['battleplan-agent-protocol:receiver-a']);
});

test('a rejected poll releases the receiver for the next trigger', async () => {
    const coordinator = createProtocolPollingCoordinator();
    let calls = 0;
    await assert.rejects(coordinator.run('receiver-a', async () => {
        calls += 1;
        throw new Error('poll failed');
    }), /poll failed/);
    await coordinator.run('receiver-a', async () => { calls += 1; });
    assert.equal(calls, 2);
});
