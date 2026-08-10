/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BattlePlanDB } from '../db.ts';
import { createAgentProtocolDeviceIdentityBootstrap } from './useAgentProtocolDeviceIdentity.ts';

test('agent protocol startup bootstraps once and exposes persistence denial to every observer', async () => {
    let identityCalls = 0;
    let persistenceCalls = 0;
    const bootstrap = createAgentProtocolDeviceIdentityBootstrap({
        db: {} as BattlePlanDB,
        ensureIdentity: async () => {
            identityCalls += 1;
            return { receiverId: 'battleplan-receiver-stable' };
        },
        requestPersistence: async () => {
            persistenceCalls += 1;
            return { status: 'denied' };
        },
    });
    const observed = await Promise.all([bootstrap(), bootstrap()]);

    assert.equal(identityCalls, 1);
    assert.equal(persistenceCalls, 1);
    assert.deepEqual(observed, [
        { phase: 'ready', receiverId: 'battleplan-receiver-stable', persistenceStatus: 'denied' },
        { phase: 'ready', receiverId: 'battleplan-receiver-stable', persistenceStatus: 'denied' },
    ]);
});

test('agent protocol startup converts bootstrap failure to visible state without rejecting', async () => {
    const bootstrap = createAgentProtocolDeviceIdentityBootstrap({
        db: {} as BattlePlanDB,
        ensureIdentity: async () => { throw new Error('identity database unavailable'); },
        requestPersistence: async () => ({ status: 'granted' }),
    });
    await assert.doesNotReject(bootstrap());
    const result = await bootstrap();
    assert.deepEqual(result, { phase: 'failed', error: 'identity database unavailable' });
});
