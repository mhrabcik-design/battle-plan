import type { SyncHealth } from '../hooks/useSyncDiagnostics.ts';
import type { GoogleAuthState, SyncVisualState } from '../types.ts';
import { isAuthUnavailable } from '../types.ts';

interface DeriveSyncVisualStateArgs {
    authState: GoogleAuthState;
    syncHealth: Record<string, SyncHealth>;
    isProcessing: boolean;
}

export function deriveSyncVisualState({
    authState,
    syncHealth,
    isProcessing,
}: DeriveSyncVisualStateArgs): SyncVisualState {
    if (isAuthUnavailable(authState)) return 'failed';

    const healthValues = Object.values(syncHealth);
    if (healthValues.some(health => health.state === 'error')) return 'failed';

    if (
        authState === 'REFRESH_PENDING' ||
        isProcessing ||
        healthValues.some(health => health.state === 'idle' || health.state === 'stale')
    ) {
        return 'pending';
    }

    return 'ok';
}
