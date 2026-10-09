import type { BattlePlanDB } from '../db.ts';
import type { CalendarSyncSettings } from './calendarModel.ts';

export const CALENDAR_ACTIVE_ACCOUNT_SETTING = 'calendar-sync-active-account';
export const calendarSettingsKey = (accountId: string) => `calendar-sync:${encodeURIComponent(accountId)}`;

export async function readCalendarSyncSettings(db: BattlePlanDB, accountId?: string): Promise<CalendarSyncSettings | undefined> {
    const account = accountId ?? (await db.settings.get(CALENDAR_ACTIVE_ACCOUNT_SETTING))?.value;
    if (!account) return undefined;
    const row = await db.settings.get(calendarSettingsKey(account));
    if (!row) return undefined;
    try {
        const settings: CalendarSyncSettings = JSON.parse(row.value);
        return settings.accountId === account && typeof settings.enabled === 'boolean'
            && typeof settings.calendarId === 'string' && settings.calendarId.length > 0
            && typeof settings.timeZone === 'string' && Array.isArray(settings.enrolledPublicIds)
            && settings.enrolledPublicIds.every(id => typeof id === 'string') ? settings : undefined;
    } catch { return undefined; }
}

/** Device-local opt-in. Enrollment queues atomically; only an observed pull authorizes delivery. */
export async function writeCalendarSyncSettings(db: BattlePlanDB, settings: CalendarSyncSettings): Promise<void> {
    await db.transaction('rw', db.settings, async () => {
        await db.settings.put({ id: calendarSettingsKey(settings.accountId), value: JSON.stringify(settings) });
        await db.settings.put({ id: CALENDAR_ACTIVE_ACCOUNT_SETTING, value: settings.accountId });
    });
}
