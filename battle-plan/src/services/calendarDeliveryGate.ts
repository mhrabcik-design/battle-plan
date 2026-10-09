import type { AgentProtocolEffectRow, BattlePlanDB } from '../db.ts';
import { readCalendarSyncSettings } from './calendarSettings.ts';

interface DeliverySession { accountId: string | null; authKey: string | null; foreground: boolean; ready: boolean }
const sessions = new WeakMap<BattlePlanDB, DeliverySession>();

/** Readiness is deliberately memory-only: persisted lastCheckedAt cannot authorize a new session. */
export function setCalendarDeliverySession(db: BattlePlanDB, session: Omit<DeliverySession, 'ready'>): void {
    const previous = sessions.get(db);
    const same = previous?.accountId === session.accountId && previous.authKey === session.authKey
        && previous.foreground === session.foreground;
    sessions.set(db, { ...session, ready: Boolean(same && previous?.ready) });
}
export function markCalendarPullReady(db: BattlePlanDB, accountId: string, authKey: string): void {
    const session = sessions.get(db);
    if (session?.foreground && session.accountId === accountId && session.authKey === authKey) session.ready = true;
}
export function invalidateCalendarPull(db: BattlePlanDB): void {
    const session = sessions.get(db);
    if (session) session.ready = false;
}

/** Shared by background and immediate callers, including old projection-less durable intents. */
export async function calendarEffectDeliveryAllowed(db: BattlePlanDB, effect: AgentProtocolEffectRow,
    accountId: string | null, authKey: string | null): Promise<boolean> {
    if (effect.kind !== 'calendar') return true;
    const settings = effect.accountId ? await readCalendarSyncSettings(db, effect.accountId) : undefined;
    if (!settings?.enabled) return effect.payload.automatic !== true;
    const session = sessions.get(db);
    return Boolean(session?.ready && session.foreground && session.accountId === effect.accountId
        && accountId === effect.accountId && session.authKey === authKey);
}
