import type { AgentPersistenceStatus, BattlePlanDB } from '../../db.ts';

export interface DeviceIdentity {
    receiverId: string;
}

export interface DeviceIdentityOptions {
    randomUUID?: () => string;
    now?: number;
}

export interface StoragePersistenceApi {
    persisted(): Promise<boolean>;
    persist(): Promise<boolean>;
}

export interface ProtocolPersistenceResult {
    status: AgentPersistenceStatus;
}

export async function ensureDeviceIdentity(
    db: BattlePlanDB,
    options: DeviceIdentityOptions = {},
): Promise<DeviceIdentity> {
    return db.transaction('rw', db.agentReceiverCapabilities, async () => {
        const existing = await db.agentReceiverCapabilities.toCollection().first();
        if (existing) return { receiverId: existing.receiverId };

        const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
        const now = options.now ?? Date.now();
        const receiverId = `battleplan-receiver-${randomUUID()}`;
        await db.agentReceiverCapabilities.add({
            receiverId,
            enabled: false,
            status: 'unpaired',
            persistenceStatus: 'unknown',
            createdAt: now,
            updatedAt: now,
        });
        return { receiverId };
    });
}

/**
 * Requests browser persistence and stores the observable guarantee. A denied,
 * unavailable, or later-lost grant is explicit; callers must not advertise an
 * exactly-once execution guarantee in those states.
 */
export async function requestProtocolPersistence(
    db: BattlePlanDB,
    receiverId: string,
    storage: StoragePersistenceApi | undefined = globalThis.navigator?.storage,
    now = Date.now(),
): Promise<ProtocolPersistenceResult> {
    const receiver = await db.agentReceiverCapabilities.get(receiverId);
    if (!receiver) throw new Error('receiver_identity_missing');

    let status: AgentPersistenceStatus;
    const wasGranted = receiver.persistenceStatus === 'granted' || receiver.persistenceStatus === 'lost';
    if (!storage) {
        status = wasGranted ? 'lost' : 'unavailable';
    } else {
        try {
            const alreadyGranted = await storage.persisted();
            const granted = alreadyGranted || await storage.persist();
            if (granted) status = 'granted';
            else status = wasGranted ? 'lost' : 'denied';
        } catch {
            status = wasGranted ? 'lost' : 'unavailable';
        }
    }

    await db.agentReceiverCapabilities.update(receiverId, {
        persistenceStatus: status,
        persistenceCheckedAt: now,
        updatedAt: now,
    });
    return { status };
}
