import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { googleService } from '../services/googleService';
import { drainGoogleExternalEffects } from '../services/externalEffectOutbox.ts';
import { GoogleCalendarSync, type CalendarSyncRange, type CalendarConflictVersion } from '../services/googleCalendarSync.ts';
import { hasUsableAuth, type GoogleAuthStatus } from '../types';

const calendarSync = new GoogleCalendarSync(db, googleService, {
    drain: () => drainGoogleExternalEffects(),
    isSessionCurrent: session => session.accountId === googleService.getAccountId()
        && session.authKey === googleService.getAuthStatus().accessToken && hasUsableAuth(googleService.getAuthStatus()),
});

/** Mount once in the ready app shell. All foreground triggers share the service's surviving flight. */
export function useGoogleCalendarSync({ googleAuth, isOnline, ready = true }: {
    googleAuth: GoogleAuthStatus; isOnline: boolean; ready?: boolean;
}) {
    const [wake, setWake] = useState(0);
    const accountId = googleService.getAccountId();
    const status = useLiveQuery(() => calendarSync.getStatus(), [wake, accountId]);

    useEffect(() => calendarSync.subscribe(() => setWake(value => value + 1)), []);
    useEffect(() => {
        let stopped = false;
        const foreground = () => ready && document.visibilityState !== 'hidden';
        const configure = () => calendarSync.setSession({ accountId: googleService.getAccountId(),
            authKey: googleService.getAuthStatus().accessToken, usableAuth: hasUsableAuth(googleService.getAuthStatus()),
            online: isOnline && navigator.onLine !== false, visible: foreground() });
        const run = () => {
            void configure().then(() => { if (!stopped && foreground()) return calendarSync.refresh(); }).catch(() => {
                // The service publishes a safe, durable status; event callbacks cannot reject into the browser.
            });
        };
        run();
        const timer = window.setInterval(() => { if (foreground()) run(); }, 60_000);
        window.addEventListener('focus', run);
        window.addEventListener('online', run);
        document.addEventListener('visibilitychange', run);
        return () => {
            stopped = true;
            window.clearInterval(timer);
            window.removeEventListener('focus', run);
            window.removeEventListener('online', run);
            document.removeEventListener('visibilitychange', run);
            void calendarSync.setSession({ accountId: googleService.getAccountId(), authKey: googleService.getAuthStatus().accessToken,
                usableAuth: hasUsableAuth(googleService.getAuthStatus()), online: isOnline, visible: false });
        };
    }, [googleAuth.state, googleAuth.accessToken, isOnline, ready, accountId]);

    return {
        status,
        preview: (range?: CalendarSyncRange, timeZone?: string) => calendarSync.preview(range, timeZone),
        activate: async (input: { range: CalendarSyncRange; selectedPublicIds: string[]; timeZone?: string }) => {
            await calendarSync.activate(input); await calendarSync.refresh();
        },
        disable: () => calendarSync.disable(),
        refresh: () => calendarSync.refresh(),
        resolveConflict: async (publicId: string, choice: 'google' | 'battleplan', expected: CalendarConflictVersion) => {
            const result = await calendarSync.resolveConflict(publicId, choice, expected);
            if (result === 'resolved') await calendarSync.refresh();
            return result;
        },
        restoreTaskBlock: async (publicId: string) => {
            await calendarSync.restoreTaskBlock(publicId); await calendarSync.refresh();
        },
    };
}
export type GoogleCalendarSyncControls = ReturnType<typeof useGoogleCalendarSync>;
