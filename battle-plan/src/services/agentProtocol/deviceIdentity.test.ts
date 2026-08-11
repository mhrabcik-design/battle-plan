/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BattlePlanDB } from '../../db.ts';
import { ensureDeviceIdentity, requestProtocolPersistence, type StoragePersistenceApi } from './deviceIdentity.ts';

test('device receiver identity is stable and persistence denial is durable and visible', async () => {
    const db = new BattlePlanDB(`BattlePlan-device-denied-${Date.now()}-${Math.random()}`);
    await db.open();
    const storage: StoragePersistenceApi = {
        persisted: async () => false,
        persist: async () => false,
    };
    try {
        const first = await ensureDeviceIdentity(db, { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
        const second = await ensureDeviceIdentity(db, { randomUUID: () => 'different-value' });
        assert.equal(second.receiverId, first.receiverId);

        const status = await requestProtocolPersistence(db, first.receiverId, storage, 100);
        assert.equal(status.status, 'denied');
        assert.equal((await db.agentReceiverCapabilities.get(first.receiverId))?.persistenceStatus, 'denied');
    } finally {
        await db.delete();
    }
});

test('loss of a previously granted persistent-storage guarantee is reported as lost', async () => {
    const db = new BattlePlanDB(`BattlePlan-device-lost-${Date.now()}-${Math.random()}`);
    await db.open();
    const identity = await ensureDeviceIdentity(db, { randomUUID: () => '22222222-2222-4222-8222-222222222222' });
    try {
        await requestProtocolPersistence(db, identity.receiverId, {
            persisted: async () => true,
            persist: async () => true,
        }, 100);
        const lost = await requestProtocolPersistence(db, identity.receiverId, {
            persisted: async () => false,
            persist: async () => false,
        }, 200);
        assert.equal(lost.status, 'lost');
        assert.deepEqual(lost, { status: 'lost' });
        const stillLost = await requestProtocolPersistence(db, identity.receiverId, {
            persisted: async () => { throw new Error('storage unavailable'); },
            persist: async () => false,
        }, 300);
        assert.deepEqual(stillLost, { status: 'lost' });
        assert.equal((await db.agentReceiverCapabilities.get(identity.receiverId))?.persistenceStatus, 'lost');
    } finally {
        await db.delete();
    }
});

test('missing or failing persistence API remains explicit', async () => {
    const db = new BattlePlanDB(`BattlePlan-device-unavailable-${Date.now()}-${Math.random()}`);
    await db.open();
    const identity = await ensureDeviceIdentity(db, { randomUUID: () => '33333333-3333-4333-8333-333333333333' });
    try {
        assert.deepEqual(await requestProtocolPersistence(db, identity.receiverId, undefined, 100), {
            status: 'unavailable',
        });
        assert.deepEqual(await requestProtocolPersistence(db, identity.receiverId, {
            persisted: async () => { throw new Error('blocked'); },
            persist: async () => { throw new Error('blocked'); },
        }, 200), { status: 'unavailable' });
        assert.equal((await db.agentReceiverCapabilities.get(identity.receiverId))?.persistenceStatus, 'unavailable');
    } finally {
        await db.delete();
    }
});
