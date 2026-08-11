export interface ProtocolWebLockManager {
    request(name: string, callback: () => Promise<void>): Promise<void>;
}

export interface ProtocolPollingCoordinator {
    run(receiverId: string, work: () => Promise<void>): Promise<void>;
}

const inFlightByReceiver = new Map<string, Promise<unknown>>();

export function createProtocolPollingCoordinator(
    lockManager: ProtocolWebLockManager | undefined = globalThis.navigator?.locks,
): ProtocolPollingCoordinator {
    return {
        run(receiverId: string, work: () => Promise<void>): Promise<void> {
            const existing = inFlightByReceiver.get(receiverId);
            if (existing) return existing.then(() => undefined);

            const lockName = `battleplan-agent-protocol:${receiverId}`;
            const promise = Promise.resolve().then(() => (
                lockManager ? lockManager.request(lockName, work) : work()
            ));
            inFlightByReceiver.set(receiverId, promise);
            void promise.finally(() => {
                if (inFlightByReceiver.get(receiverId) === promise) inFlightByReceiver.delete(receiverId);
            }).catch(() => undefined);
            return promise;
        },
    };
}
