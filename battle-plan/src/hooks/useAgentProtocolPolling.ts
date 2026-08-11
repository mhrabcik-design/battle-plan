import { useEffect } from 'react';

import {
    createProtocolPollingCoordinator,
    type ProtocolPollingCoordinator,
} from '../services/agentProtocol/pollingCoordinator.ts';

interface PollingEventTarget {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}

export interface ProtocolPollingScheduler {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(callback: () => void, delayMs: number): unknown;
    clearInterval(handle: unknown): void;
}

export interface StartAgentProtocolPollingOptions {
    receiverId: string;
    poll: () => Promise<void>;
    coordinator: ProtocolPollingCoordinator;
    scheduler: ProtocolPollingScheduler;
    documentTarget?: PollingEventTarget;
    windowTarget?: PollingEventTarget;
    initialDelayMs?: number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
}

export interface UseAgentProtocolPollingOptions {
    enabled: boolean;
    receiverId?: string;
    poll: () => Promise<void>;
    initialDelayMs?: number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
}

const coordinator = createProtocolPollingCoordinator();

const browserScheduler: ProtocolPollingScheduler = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export function startAgentProtocolPolling(options: StartAgentProtocolPollingOptions): () => void {
    const {
        receiverId,
        poll,
        scheduler,
        documentTarget,
        windowTarget,
        initialDelayMs = 3_000,
        intervalMs = 5_000,
        onError = (error) => console.error('Agent protocol polling failed', error),
    } = options;
    let cancelled = false;

    const trigger = (): void => {
        if (cancelled) return;
        void options.coordinator.run(receiverId, async () => {
            if (!cancelled) await poll();
        }).catch((error) => {
            if (!cancelled) onError(error);
        });
    };

    const initialTimer = scheduler.setTimeout(trigger, initialDelayMs);
    const interval = scheduler.setInterval(trigger, intervalMs);
    documentTarget?.addEventListener('visibilitychange', trigger);
    windowTarget?.addEventListener('focus', trigger);

    return () => {
        cancelled = true;
        scheduler.clearTimeout(initialTimer);
        scheduler.clearInterval(interval);
        documentTarget?.removeEventListener('visibilitychange', trigger);
        windowTarget?.removeEventListener('focus', trigger);
    };
}

export function useAgentProtocolPolling(options: UseAgentProtocolPollingOptions): void {
    const { enabled, receiverId, poll, initialDelayMs, intervalMs, onError } = options;

    useEffect(() => {
        if (!enabled || !receiverId) return;
        return startAgentProtocolPolling({
            receiverId,
            poll,
            coordinator,
            scheduler: browserScheduler,
            documentTarget: globalThis.document,
            windowTarget: globalThis.window,
            initialDelayMs,
            intervalMs,
            onError,
        });
    }, [enabled, receiverId, poll, initialDelayMs, intervalMs, onError]);
}
