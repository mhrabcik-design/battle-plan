import { useEffect } from 'react';

import { db, type AgentPersistenceStatus, type BattlePlanDB } from '../db.ts';
import { getErrorMessage } from '../utils/errors.ts';
import {
    ensureDeviceIdentity,
    requestProtocolPersistence,
    type DeviceIdentity,
    type ProtocolPersistenceResult,
} from '../services/agentProtocol/deviceIdentity.ts';

export type SettledAgentProtocolDeviceIdentityState =
    | {
        phase: 'ready';
        receiverId: string;
        persistenceStatus: AgentPersistenceStatus;
    }
    | { phase: 'failed'; error: string };

export interface AgentProtocolDeviceIdentityBootstrapDependencies {
    db: BattlePlanDB;
    ensureIdentity?: (db: BattlePlanDB) => Promise<DeviceIdentity>;
    requestPersistence?: (db: BattlePlanDB, receiverId: string) => Promise<ProtocolPersistenceResult>;
}

export type AgentProtocolDeviceIdentityBootstrap = () => Promise<SettledAgentProtocolDeviceIdentityState>;

/**
 * Creates a single-flight startup operation. The settled promise is retained so
 * React StrictMode remounts observe the same receiver bootstrap instead of
 * creating or checking it twice. Failures are values, not rejected promises.
 */
export function createAgentProtocolDeviceIdentityBootstrap(
    dependencies: AgentProtocolDeviceIdentityBootstrapDependencies,
): AgentProtocolDeviceIdentityBootstrap {
    const ensureIdentity = dependencies.ensureIdentity ?? ensureDeviceIdentity;
    const requestPersistence = dependencies.requestPersistence ?? requestProtocolPersistence;
    let startup: Promise<SettledAgentProtocolDeviceIdentityState> | undefined;

    return () => {
        startup ??= (async () => {
            try {
                const identity = await ensureIdentity(dependencies.db);
                const persistence = await requestPersistence(dependencies.db, identity.receiverId);
                return {
                    phase: 'ready' as const,
                    receiverId: identity.receiverId,
                    persistenceStatus: persistence.status,
                };
            } catch (error) {
                return { phase: 'failed' as const, error: getErrorMessage(error) };
            }
        })();
        return startup;
    };
}

const productionBootstrap = createAgentProtocolDeviceIdentityBootstrap({ db });

export interface UseAgentProtocolDeviceIdentityOptions {
    onSettled?: (state: SettledAgentProtocolDeviceIdentityState) => void;
}

export function useAgentProtocolDeviceIdentity(
    options: UseAgentProtocolDeviceIdentityOptions = {},
): void {
    const { onSettled } = options;

    useEffect(() => {
        let active = true;
        void productionBootstrap().then((settled) => {
            if (!active) return;
            onSettled?.(settled);
        }).catch((error) => {
            if (!active) return;
            const failed = { phase: 'failed' as const, error: getErrorMessage(error) };
            onSettled?.(failed);
        });
        return () => {
            active = false;
        };
    }, [onSettled]);
}
