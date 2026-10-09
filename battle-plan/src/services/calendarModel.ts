/** The schedule is one shared field: its endpoints must never merge independently. */
export type CalendarTiming =
    | { kind: 'all-day'; startDate: string; endDate: string }
    | { kind: 'timed'; start: string; end: string; timeZone: string };

export interface CalendarPublicProjection {
    title: string;
    description: string;
    timing: CalendarTiming;
}

export type CalendarReadonlyReason = 'recurring' | 'multi-day' | 'foreign-organizer' | 'unsupported-type' | 'unsupported-timing';

export interface CalendarConflict {
    kind: 'fields' | 'remote-deleted' | 'local-deleted' | 'legacy-baseline';
    fields: ('title' | 'description' | 'timing')[];
    base?: CalendarPublicProjection;
    local?: CalendarPublicProjection;
    remote?: CalendarPublicProjection;
    remoteEtag?: string;
    detectedAt: number;
}

/** Portable pairing/bookkeeping; its clock is independent of Task.updatedAt. */
export interface TaskCalendarMetadata {
    accountId: string;
    calendarId: string;
    eventId: string;
    canonicalIdentity: string;
    origin: 'local' | 'google';
    generation: number;
    metadataUpdatedAt: number;
    baseline?: CalendarPublicProjection;
    etag?: string;
    timing?: CalendarTiming;
    readonlyReason?: CalendarReadonlyReason;
    htmlLink?: string;
    recurringEventId?: string;
    originalStartTime?: GoogleCalendarDateTime;
    eventType?: string;
    suppressed?: boolean;
    conflict?: CalendarConflict;
}

export interface GoogleCalendarDateTime { date?: string; dateTime?: string; timeZone?: string }

/** API resource contract shared by the later adapter and inbound reducer. */
export interface GoogleCalendarEvent {
    id: string;
    etag?: string;
    status?: 'confirmed' | 'tentative' | 'cancelled';
    summary?: string;
    description?: string;
    start?: GoogleCalendarDateTime;
    end?: GoogleCalendarDateTime;
    htmlLink?: string;
    recurringEventId?: string;
    recurrence?: string[];
    originalStartTime?: GoogleCalendarDateTime;
    eventType?: string;
    organizer?: { email?: string; self?: boolean };
    extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
    attendees?: { email?: string; responseStatus?: string; [key: string]: unknown }[];
    reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
    location?: string;
    conferenceData?: Record<string, unknown>;
    updated?: string;
}

export interface CalendarSyncSettings {
    accountId: string;
    calendarId: string;
    enabled: boolean;
    timeZone: string;
    enrolledPublicIds: string[];
    activatedAt?: number;
    lastCheckedAt?: number;
}
