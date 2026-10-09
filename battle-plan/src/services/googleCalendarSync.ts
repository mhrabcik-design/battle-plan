import { type BattlePlanDB, type Task } from '../db.ts';
import type { CalendarConflict, CalendarPublicProjection, CalendarReadonlyReason, CalendarSyncSettings,
    GoogleCalendarEvent, TaskCalendarMetadata } from './calendarModel.ts';
import { calendarEventProjection, calendarEventPublicId, calendarProjectionToTaskSchedule, canonicalCalendarIdentity,
    deterministicCalendarEventId, toCalendarProjection } from './calendarMapping.ts';
import { calendarChangedFields, rebaseCalendarProjection, reconcileCalendarProjection, safeGoogleCalendarLink } from './calendarReconciliation.ts';
import { CALENDAR_ACTIVE_ACCOUNT_SETTING, readCalendarSyncSettings, writeCalendarSyncSettings } from './calendarSettings.ts';
import { invalidateCalendarPull, markCalendarPullReady, setCalendarDeliverySession } from './calendarDeliveryGate.ts';
import { ExternalEffectOutbox } from './externalEffectOutbox.ts';
import { newTaskMutationContext, projectTaskForProtocol, TaskMutationService, taskMutationTables, type TaskMutationContext } from './taskMutations.ts';
import { canonicalBackupJson } from '../utils/canonicalBackupJson.ts';
import type { CalendarListOptions, CalendarListResult, CalendarReadScope, CalendarWriteGuard } from './googleService.ts';

export interface CalendarSyncSession {
    /** Only a token-verified account may be passed here; a cached email is insufficient. */
    accountId: string | null;
    authKey: string | null;
    usableAuth: boolean;
    online: boolean;
    visible: boolean;
}
interface CalendarSyncRange { startDate: string; endDate: string }
export interface CalendarSyncStatus {
    enabled: boolean;
    accountId: string | null;
    phase: 'disabled' | 'offline' | 'auth-required' | 'hidden' | 'checking' | 'ready' | 'error';
    lastCheckedAt: number | null;
    pending: number;
    conflicts: Task[];
    error: string | null;
    timeZone: string;
}
export interface CalendarConflictVersion { revisionId: string | null; metadataUpdatedAt: number }
export interface CalendarSyncClient {
    listCalendarEvents(options: CalendarListOptions, guard?: CalendarWriteGuard): Promise<CalendarListResult>;
    getCalendarEvent(eventId: string, scope: CalendarReadScope, guard?: CalendarWriteGuard): Promise<GoogleCalendarEvent | null>;
}
interface Options {
    now?: () => number;
    drain: () => Promise<unknown>;
    isSessionCurrent?: (session: CalendarSyncSession) => boolean;
}
interface SharedState {
    session: CalendarSyncSession;
    generation: number;
    flight?: Promise<void>;
    flightGeneration?: number;
    error: string | null;
    listeners: Set<() => void>;
}
const shared = new WeakMap<BattlePlanDB, SharedState>();
const inactive: CalendarSyncSession = { accountId: null, authKey: null, usableAuth: false, online: false, visible: false };
const activeEffect = (state: string) => ['pending', 'retry_scheduled', 'running'].includes(state);
const context = (accountId: string, origin: TaskMutationContext['origin'] = 'google'): TaskMutationContext =>
    newTaskMutationContext(origin, origin === 'google' ? 'battleplan-google' : 'battleplan-user', accountId);
const same = (a: unknown, b: unknown) => canonicalBackupJson(a) === canonicalBackupJson(b);
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function dateInZone(now: number, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
function addDays(date: string, days: number): string {
    return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function needsAutomaticEnrollment(task: Task, accountId: string, timeZone: string): boolean {
    return Boolean(task.publicId && !task.isDeleted && !task.googleId && !task.googleEventId
        && !task.calendar
        && (!task.googleAccountId || task.googleAccountId === accountId) && toCalendarProjection(task, timeZone));
}
function activationOperation(task: Task, settings: CalendarSyncSettings): 'upsert' | 'delete' | null {
    if (needsAutomaticEnrollment(task, settings.accountId, settings.timeZone)) return 'upsert';
    const metadata = task.calendar;
    if (!task.publicId || task.googleId || !metadata || metadata.accountId !== settings.accountId
        || metadata.calendarId !== settings.calendarId || metadata.suppressed || metadata.readonlyReason || metadata.conflict
        || !metadata.baseline || (task.googleAccountId && task.googleAccountId !== settings.accountId)) return null;
    if (task.isDeleted) return task.googleEventId || task.reservedGoogleEventId ? 'delete' : null;
    const projection = toCalendarProjection(task, settings.timeZone);
    return projection && calendarChangedFields(metadata.baseline, projection).length ? 'upsert' : null;
}
function listBoundary(date: string, timeZone: string): string {
    const value = toCalendarProjection({ title: '', type: 'meeting', urgency: 2, status: 'pending', date, startTime: '00:00',
        duration: 60, updatedAt: 0, createdAt: 0 }, timeZone);
    if (value?.timing.kind !== 'timed') throw new Error('Neplatné časové pásmo Kalendáře.');
    return value.timing.start;
}
function readonlyReason(event: GoogleCalendarEvent, projection: CalendarPublicProjection | null, displayZone: string): CalendarReadonlyReason | undefined {
    if (event.recurringEventId || event.recurrence?.length) return 'recurring';
    if (event.organizer?.self !== true) return 'foreign-organizer';
    if (event.eventType && event.eventType !== 'default') return 'unsupported-type';
    if (!projection) return 'unsupported-timing';
    const timing = projection.timing;
    if (timing.kind === 'all-day') return timing.endDate !== addDays(timing.startDate, 1) ? 'multi-day' : undefined;
    return dateInZone(Date.parse(timing.start), displayZone) !== dateInZone(Date.parse(timing.end) - 1, displayZone) ? 'multi-day' : undefined;
}
function privateIdentity(event: GoogleCalendarEvent, accountId: string, calendarId: string) {
    if (event.recurringEventId) return; // Instances inherit the master's properties, never its identity.
    const fields = event.extendedProperties?.private;
    if (!fields || fields.battleplanAccount !== accountId || fields.battleplanCalendar !== calendarId
        || !['task', 'meeting'].includes(fields.battleplanType) || !['local', 'google'].includes(fields.battleplanOrigin)) return;
    const generation = Number(fields.battleplanGeneration);
    if (!/^\d+$/.test(fields.battleplanGeneration ?? '') || !Number.isSafeInteger(generation)
        || !/^(public:task_.+|occurrence:.+)$/.test(fields.battleplanIdentity ?? '')) return;
    return { canonicalIdentity: fields.battleplanIdentity, generation, type: fields.battleplanType as 'task' | 'meeting',
        origin: fields.battleplanOrigin as 'local' | 'google' };
}

/** Browser-active primary Calendar sync. Network reads finish before the single atomic domain commit. */
export class GoogleCalendarSync {
    private readonly db: BattlePlanDB;
    private readonly client: CalendarSyncClient;
    private readonly options: Options;
    private readonly state: SharedState;
    private readonly now: () => number;

    constructor(db: BattlePlanDB, client: CalendarSyncClient, options: Options) {
        this.db = db; this.client = client; this.options = options; this.now = options.now ?? Date.now;
        let state = shared.get(db);
        if (!state) { state = { session: inactive, generation: 0, error: null, listeners: new Set() }; shared.set(db, state); }
        this.state = state;
    }

    subscribe(listener: () => void): () => void {
        this.state.listeners.add(listener);
        return () => this.state.listeners.delete(listener);
    }
    private notify(): void { for (const listener of this.state.listeners) listener(); }
    async setSession(session: CalendarSyncSession): Promise<void> {
        if (!same(session, this.state.session)) {
            this.state.session = { ...session }; this.state.generation++; this.state.error = null;
            setCalendarDeliverySession(this.db, { accountId: session.accountId, authKey: session.authKey,
                foreground: this.foreground() });
            this.notify();
        }
        // Offline authors retain the last verified account after logout. A verified
        // replacement account takes ownership of the fallback even when sync is off.
        if (session.accountId && session.authKey && session.usableAuth && (this.options.isSessionCurrent?.(session) ?? true)) {
            const generation = this.state.generation;
            await this.db.transaction('rw', this.db.settings, async () => {
                if (generation !== this.state.generation) return;
                const row = await this.db.settings.get(CALENDAR_ACTIVE_ACCOUNT_SETTING);
                if (row?.value !== session.accountId && generation === this.state.generation)
                    await this.db.settings.put({ id: CALENDAR_ACTIVE_ACCOUNT_SETTING, value: session.accountId! });
            });
        }
    }
    private foreground(): boolean {
        const session = this.state.session;
        return Boolean(session.accountId && session.authKey && session.usableAuth && session.online && session.visible
            && (this.options.isSessionCurrent?.(session) ?? true));
    }
    private capture() {
        if (!this.foreground()) throw new Error('Kalendář čeká na připojení, přihlášení a otevřenou aplikaci.');
        const session = { ...this.state.session }, generation = this.state.generation;
        const current = () => generation === this.state.generation && this.foreground();
        return { session, generation, current, guard: { isCurrent: async () => current() } };
    }
    private defaultRange(timeZone: string): CalendarSyncRange {
        const today = dateInZone(this.now(), timeZone);
        return { startDate: addDays(today, -30), endDate: addDays(today, 181) };
    }
    async activate(timeZone?: string): Promise<void> {
        const capture = this.capture();
        const accountId = capture.session.accountId!;
        await this.db.transaction('rw', taskMutationTables(this.db), async () => {
            if (!capture.current()) throw new Error('Přihlášení ke Kalendáři se změnilo.');
            const old = await readCalendarSyncSettings(this.db, accountId);
            if (old?.enabled) return;
            const zone = old?.timeZone ?? timeZone ?? browserZone();
            listBoundary(dateInZone(this.now(), zone), zone);
            const settings: CalendarSyncSettings = { ...old, accountId, calendarId: 'primary', enabled: true,
                timeZone: zone, enrolledPublicIds: old?.enrolledPublicIds ?? [], activatedAt: old?.activatedAt ?? this.now() };
            await writeCalendarSyncSettings(this.db, settings);
            const mutations = new TaskMutationService(this.db, { now: this.now });
            for (const task of await this.db.tasks.toArray()) {
                const operation = activationOperation(task, settings);
                if (!operation) continue;
                const result = await mutations.queueEffects({ publicId: task.publicId,
                    expectedRevision: task.protocolRevision?.revision_id ?? null, context: context(accountId, 'ui'),
                    effects: [{ kind: 'calendar', operation, automatic: true }] });
                if (result.status !== 'queued') throw new Error('Místní položka se během zapnutí synchronizace změnila.');
            }
            if (!capture.current()) throw new Error('Přihlášení ke Kalendáři se změnilo.');
        });
        invalidateCalendarPull(this.db); this.state.error = null; this.notify();
    }
    async disable(): Promise<void> {
        const accountId = this.state.session.accountId ?? (await this.db.settings.get(CALENDAR_ACTIVE_ACCOUNT_SETTING))?.value;
        if (!accountId) return;
        await this.db.transaction('rw', this.db.settings, async () => {
            const settings = await readCalendarSyncSettings(this.db, accountId);
            if (settings) await writeCalendarSyncSettings(this.db, { ...settings, enabled: false });
        });
        this.state.generation++; invalidateCalendarPull(this.db); this.state.error = null; this.notify();
    }
    async getStatus(): Promise<CalendarSyncStatus> {
        const accountId = this.state.session.accountId ?? (await this.db.settings.get(CALENDAR_ACTIVE_ACCOUNT_SETTING))?.value ?? null;
        const settings = accountId ? await readCalendarSyncSettings(this.db, accountId) : undefined;
        const [tasks, pending] = await Promise.all([this.db.tasks.toArray(), this.db.agentProtocolEffects
            .where('state').anyOf(['pending', 'retry_scheduled', 'running'])
            .and(effect => effect.kind === 'calendar' && effect.accountId === accountId).count()]);
        const enabled = settings?.enabled === true;
        const session = this.state.session;
        let phase: CalendarSyncStatus['phase'] = 'ready';
        if (!enabled) phase = 'disabled';
        else if (!session.online) phase = 'offline';
        else if (!session.accountId || !session.usableAuth || !session.authKey) phase = 'auth-required';
        else if (!session.visible) phase = 'hidden';
        else if (this.state.flight) phase = 'checking';
        else if (this.state.error) phase = 'error';
        return { accountId, enabled, phase, error: this.state.error, timeZone: settings?.timeZone ?? browserZone(),
            lastCheckedAt: settings?.lastCheckedAt ?? null,
            pending,
            conflicts: tasks.filter(task => task.calendar?.accountId === accountId && task.calendar.conflict) };
    }

    /** Shared promise survives hook teardown/remount. Triggers during the same read collapse. */
    refresh(): Promise<void> {
        if (this.state.flight) {
            if (this.state.flightGeneration === this.state.generation || !this.foreground()) return this.state.flight;
            return this.state.flight.catch(() => {}).then(() => this.refresh());
        }
        if (!this.foreground()) { this.notify(); return Promise.resolve(); }
        const capture = this.capture();
        const flight = this.pull(capture).catch(error => {
            if (capture.current()) this.state.error = 'Kontrola Kalendáře se nepodařila. Změny zůstávají uložené pro další pokus.';
            throw error;
        }).finally(() => { if (this.state.flight === flight) this.state.flight = undefined; this.notify(); });
        this.state.flight = flight; this.state.flightGeneration = capture.generation; this.notify();
        return flight;
    }
    private async pull(capture: ReturnType<GoogleCalendarSync['capture']>): Promise<void> {
        const accountId = capture.session.accountId!;
        const settings = await readCalendarSyncSettings(this.db, accountId);
        if (!settings?.enabled || !capture.current()) return;
        // Observation rolls with today; local plans are enrolled regardless of date.
        const range = this.defaultRange(settings.timeZone);
        const localTasks = await this.db.tasks.toArray();
        const unlinked = localTasks.filter(task => needsAutomaticEnrollment(task, accountId, settings.timeZone));
        const observedPublicIds = new Set(unlinked.map(task => task.publicId!));
        const tracked = localTasks.filter(task =>
            (task.calendar?.accountId === accountId && task.calendar.calendarId === settings.calendarId)
            || (!task.calendar && (task.googleEventId || task.reservedGoogleEventId) && task.googleAccountId === accountId));
        const result = await this.client.listCalendarEvents({ accountId, calendarId: settings.calendarId,
            timeMin: listBoundary(range.startDate, settings.timeZone), timeMax: listBoundary(range.endDate, settings.timeZone),
            timeZone: settings.timeZone }, capture.guard);
        const events = new Map<string, GoogleCalendarEvent | null>();
        for (const event of result.events) {
            if (!event.id || events.has(event.id)) throw new Error('Neúplný nebo nejednoznačný výsledek Kalendáře.');
            events.set(event.id, event);
        }
        const targets = new Set([...tracked.map(task => task.calendar?.eventId ?? task.googleEventId ?? task.reservedGoogleEventId!),
            ...unlinked.map(task => task.reservedGoogleEventId ?? deterministicCalendarEventId(task, accountId, settings.calendarId, 0))]);
        for (const eventId of targets) {
            if (events.has(eventId)) continue;
            const event = await this.client.getCalendarEvent(eventId, { accountId, calendarId: settings.calendarId }, capture.guard);
            if (event && event.id !== eventId) throw new Error('Kalendář vrátil jinou identitu události.');
            events.set(eventId, event);
        }
        if (!capture.current()) return;
        const committed = await this.db.transaction('rw', taskMutationTables(this.db), async () => {
            const currentSettings = await readCalendarSyncSettings(this.db, accountId);
            if (!capture.current() || !currentSettings?.enabled || !same(settings, currentSettings)) return false;
            // One fresh table read for the entire batch, updated as mutations commit.
            const tasks = await this.db.tasks.toArray();
            for (const [eventId, event] of events) {
                if (!capture.current()) throw new Error('Přihlášení ke Kalendáři se změnilo.');
                await this.importEvent(eventId, event, settings, tasks);
            }
            const mutations = new TaskMutationService(this.db, { now: this.now });
            for (const task of tasks) {
                if (!observedPublicIds.has(task.publicId!) || !needsAutomaticEnrollment(task, accountId, settings.timeZone)) continue;
                const result = await mutations.queueEffects({ publicId: task.publicId,
                    expectedRevision: task.protocolRevision?.revision_id ?? null, context: context(accountId, 'ui'),
                    effects: [{ kind: 'calendar', operation: 'upsert', automatic: true }] });
                if (result.status !== 'queued') throw new Error('Místní položka se během synchronizace změnila.');
            }
            if (!capture.current()) throw new Error('Přihlášení ke Kalendáři se změnilo.');
            await writeCalendarSyncSettings(this.db, { ...currentSettings, lastCheckedAt: this.now() });
            return true;
        });
        if (!committed || !capture.current()) return;
        markCalendarPullReady(this.db, accountId, capture.session.authKey!);
        this.state.error = null; this.notify();
        await this.options.drain();
    }

    private findTask(eventId: string, event: GoogleCalendarEvent | null, settings: CalendarSyncSettings, tasks: Task[]): Task | undefined {
        const direct = tasks.filter(task => task.calendar
            ? task.calendar.accountId === settings.accountId && task.calendar.calendarId === settings.calendarId && task.calendar.eventId === eventId
            : task.googleAccountId === settings.accountId && (task.googleEventId === eventId || task.reservedGoogleEventId === eventId));
        if (direct.length > 1) throw new Error('Jedna Calendar událost má více místních položek.');
        if (direct[0]) return direct[0];
        const identity = event ? privateIdentity(event, settings.accountId, settings.calendarId) : undefined;
        if (identity) {
            const candidates = tasks.filter(task => (!task.calendar || (task.calendar.accountId === settings.accountId && task.calendar.calendarId === settings.calendarId))
                && (!task.googleAccountId || task.googleAccountId === settings.accountId)
                && canonicalCalendarIdentity(task) === identity.canonicalIdentity);
            if (candidates.length > 1) throw new Error('Calendar identita má více místních položek.');
            const candidate = candidates[0];
            if (candidate) {
                const target = candidate.calendar?.eventId ?? candidate.googleEventId ?? candidate.reservedGoogleEventId;
                if (target && target !== eventId && (!candidate.calendar || identity.generation <= candidate.calendar.generation)) return;
                return candidate;
            }
        }
        return tasks.find(task => task.publicId === calendarEventPublicId(settings.accountId, settings.calendarId, eventId));
    }
    private async save(task: Task, previous?: Task, batch?: Task[]): Promise<void> {
        if (previous?.calendar && task.calendar) {
            const old = { ...previous.calendar, metadataUpdatedAt: 0 }, next = { ...task.calendar, metadataUpdatedAt: 0 };
            task.calendar.metadataUpdatedAt = same(old, next) ? previous.calendar.metadataUpdatedAt : Math.max(this.now(), previous.calendar.metadataUpdatedAt + 1);
        }
        const changed = !previous || !same(projectTaskForProtocol(previous), projectTaskForProtocol(task));
        task.updatedAt = changed ? Math.max(this.now(), (previous?.updatedAt ?? -1) + 1) : previous!.updatedAt;
        const result = await new TaskMutationService(this.db, { now: this.now }).importTask({ task, localId: previous?.id,
            expectedRevision: previous?.protocolRevision?.revision_id ?? null, context: context(task.calendar!.accountId) });
        if (result.status !== 'applied' && result.status !== 'unchanged') throw new Error('Místní položka se během importu změnila.');
        if (batch) {
            const index = batch.findIndex(row => row.id === result.task.id);
            if (index < 0) batch.push(result.task); else batch[index] = result.task;
        }
    }
    private applyProjection(task: Task, projection: CalendarPublicProjection): Task {
        const type = task.type === 'task' ? 'task' : 'meeting';
        const schedule = calendarProjectionToTaskSchedule(projection, type, task.calendar?.displayTimeZone);
        if (!schedule) return task;
        if (type === 'task' && projection.timing.kind === 'all-day') schedule.duration = task.duration;
        return { ...task, title: projection.title, description: projection.description, ...schedule, calendarScheduleExplicit: true };
    }
    private async importEvent(eventId: string, event: GoogleCalendarEvent | null, settings: CalendarSyncSettings, tasks: Task[]): Promise<void> {
        const identity = event ? privateIdentity(event, settings.accountId, settings.calendarId) : undefined;
        if (identity) {
            const owner = tasks.find(task => task.calendar?.accountId === settings.accountId
                && task.calendar.calendarId === settings.calendarId && task.calendar.canonicalIdentity === identity.canonicalIdentity);
            // An old active generation can still be returned by the finite list.
            // It must neither resurrect a block nor poison an otherwise complete batch.
            if (owner?.calendar && owner.calendar.eventId !== eventId && identity.generation <= owner.calendar.generation) return;
        }
        const previous = this.findTask(eventId, event, settings, tasks);
        if (!event || event.status === 'cancelled') {
            // A never-created reserved target is not a remote deletion.
            if (!previous || (!previous.googleEventId && !previous.calendar?.baseline && previous.calendar?.origin !== 'google')) return;
            const local = toCalendarProjection(previous, settings.timeZone) ?? undefined;
            const metadata = previous.calendar ?? { accountId: settings.accountId, calendarId: settings.calendarId, eventId,
                canonicalIdentity: canonicalCalendarIdentity(previous), origin: 'local' as const, generation: 0, metadataUpdatedAt: this.now() };
            const pending = (await this.db.agentProtocolEffects.where('entityPublicId').equals(previous.publicId!).toArray())
                .some(effect => effect.kind === 'calendar' && effect.operation === 'upsert' && activeEffect(effect.state));
            const changed = !previous.isDeleted && Boolean(local && (!metadata.baseline || calendarChangedFields(metadata.baseline, local).length || pending));
            const conflict: CalendarConflict | undefined = metadata.conflict ? { ...metadata.conflict, local, remote: undefined, remoteEtag: undefined }
                : changed ? { kind: 'remote-deleted', fields: [], base: metadata.baseline, local, detectedAt: this.now() } : undefined;
            const next = { ...previous, calendar: { ...metadata, suppressed: true, conflict } };
            if (previous.type === 'meeting' && !conflict) next.isDeleted = true;
            await this.save(next, previous, tasks); return;
        }
        const advancedGeneration = Boolean(previous?.calendar && identity && identity.generation > previous.calendar.generation);
        if (previous?.calendar && identity && (identity.canonicalIdentity !== previous.calendar.canonicalIdentity
            || identity.generation < previous.calendar.generation || identity.origin !== previous.calendar.origin)) throw new Error('Událost změnila svou Calendar identitu.');
        const projection = calendarEventProjection(event, settings.timeZone);
        const readonly = readonlyReason(event, projection, settings.timeZone);
        const publicId = previous?.publicId ?? (identity?.canonicalIdentity.startsWith('public:')
            ? identity.canonicalIdentity.slice(7) : calendarEventPublicId(settings.accountId, settings.calendarId, eventId));
        const metadata: TaskCalendarMetadata = { ...previous?.calendar, accountId: settings.accountId, calendarId: settings.calendarId,
            eventId, canonicalIdentity: previous?.calendar?.canonicalIdentity ?? identity?.canonicalIdentity ?? `public:${publicId}`,
            origin: previous?.calendar?.origin ?? (previous ? 'local' : identity?.origin ?? 'google'), generation: advancedGeneration ? identity!.generation : previous?.calendar?.generation ?? identity?.generation ?? 0,
            metadataUpdatedAt: previous?.calendar?.metadataUpdatedAt ?? this.now(), etag: event.etag,
            displayTimeZone: settings.timeZone, readonlyReason: readonly, htmlLink: safeGoogleCalendarLink(event.htmlLink),
            recurringEventId: event.recurringEventId, recurringMaster: event.recurrence?.length ? true : undefined,
            originalStartTime: event.originalStartTime, eventType: event.eventType,
            ...(projection ? { timing: projection.timing } : {}) };
        if (advancedGeneration) { metadata.suppressed = false; metadata.conflict = undefined; }
        let next: Task = previous ? { ...previous, calendar: metadata, googleEventId: eventId } : {
            publicId, title: event.summary ?? '', description: event.description ?? '', type: identity?.type ?? 'meeting', urgency: 2,
            status: 'pending', createdAt: this.now(), updatedAt: this.now(), calendar: metadata, googleEventId: eventId,
            ...(identity?.canonicalIdentity.startsWith('occurrence:') ? { suggestionOccurrenceKey: identity.canonicalIdentity.slice(11) } : {}) };
        const local = previous ? toCalendarProjection(previous, settings.timeZone) : null;
        if (!previous) { if (projection) next = this.applyProjection(next, projection); metadata.baseline = projection ?? undefined; }
        else if (metadata.conflict) {
            // An ack can advance the baseline while a successor still conflicts.
            // Observation updates the evidence, never implicitly resolves that choice.
            metadata.conflict = { ...metadata.conflict, local: local ?? undefined, remote: projection ?? undefined, remoteEtag: event.etag };
        } else if (previous.isDeleted) {
            if (projection && (!metadata.baseline || calendarChangedFields(metadata.baseline, projection).length))
                metadata.conflict = { kind: 'local-deleted', fields: metadata.baseline ? calendarChangedFields(metadata.baseline, projection) : [],
                    base: metadata.baseline, local: local ?? undefined, remote: projection, remoteEtag: event.etag, detectedAt: this.now() };
        } else if (metadata.suppressed) {
            // Same cancelled generation remains suppressed, even if an old read returns active.
        } else if (projection && local) {
            const result = reconcileCalendarProjection(metadata.baseline, local, projection, event.etag, this.now());
            if (result.conflict) metadata.conflict = result.conflict;
            else { next = this.applyProjection(next, result.projection); metadata.baseline = projection; }
        } else if (projection) { next = this.applyProjection(next, projection); metadata.baseline = projection; }
        // applyProjection preserves the same metadata object.
        await this.save(next, previous, tasks);
    }

    /** Decisions fetch fresh Google data and compare both domain revision and metadata clock after I/O. */
    async resolveConflict(publicId: string, choice: 'google' | 'battleplan', expected?: CalendarConflictVersion): Promise<'resolved' | 'stale'> {
        const capture = this.capture(), accountId = capture.session.accountId!;
        const original = await this.db.tasks.where('publicId').equals(publicId).first();
        if (expected && (!original?.calendar?.conflict || original.calendar.metadataUpdatedAt !== expected.metadataUpdatedAt
            || (original.protocolRevision?.revision_id ?? null) !== expected.revisionId)) return 'stale';
        if (!original?.calendar?.conflict || original.calendar.accountId !== accountId) throw new Error('Konflikt Kalendáře již není dostupný.');
        if (choice === 'battleplan' && original.calendar.readonlyReason) throw new Error('Tuto událost lze upravit pouze v Googlu.');
        const event = await this.client.getCalendarEvent(original.calendar.eventId, { accountId, calendarId: original.calendar.calendarId }, capture.guard);
        if (event && event.id !== original.calendar.eventId) throw new Error('Kalendář vrátil jinou identitu události.');
        if (!capture.current()) return 'stale';
        return this.db.transaction('rw', taskMutationTables(this.db), async () => {
            const current = await this.db.tasks.where('publicId').equals(publicId).first();
            if (!capture.current() || !current?.calendar || !same(current.protocolRevision, original.protocolRevision)
                || !same(projectTaskForProtocol(current), projectTaskForProtocol(original))
                || current.calendar.metadataUpdatedAt !== original.calendar!.metadataUpdatedAt) return 'stale';
            const remote = event?.status !== 'cancelled' && event ? calendarEventProjection(event, current.calendar.displayTimeZone ?? browserZone()) : null;
            const observed = current.calendar.conflict;
            if (!same(observed?.remote, remote ?? undefined) || observed?.remoteEtag !== event?.etag) {
                const next = { ...current, calendar: { ...current.calendar, conflict: { ...observed!,
                    local: toCalendarProjection(current) ?? undefined, remote: remote ?? undefined, remoteEtag: event?.etag,
                    ...(remote ? {} : { kind: 'remote-deleted' as const }) } } };
                await this.save(next, current);
                this.notify(); return 'stale';
            }
            const next = { ...current, calendar: { ...current.calendar, conflict: undefined, baseline: remote ?? current.calendar.baseline,
                etag: event?.etag, timing: remote?.timing ?? current.calendar.timing } };
            if (event && event.status !== 'cancelled') {
                const identity = privateIdentity(event, accountId, current.calendar.calendarId);
                if (identity && (identity.canonicalIdentity !== current.calendar.canonicalIdentity || identity.generation !== current.calendar.generation))
                    throw new Error('Událost změnila svou Calendar identitu.');
                next.calendar.readonlyReason = readonlyReason(event, remote, current.calendar.displayTimeZone ?? browserZone());
            }
            if (choice === 'battleplan' && next.calendar.readonlyReason) throw new Error('Tuto událost lze upravit pouze v Googlu.');
            if (choice === 'google') {
                if (remote) { Object.assign(next, this.applyProjection(next, remote)); next.isDeleted = false; }
                else { next.calendar.suppressed = true; if (next.type === 'meeting') next.isDeleted = true; }
            } else if (remote && !current.isDeleted) {
                const local = toCalendarProjection(current);
                if (local) Object.assign(next, this.applyProjection(next, rebaseCalendarProjection(local, observed?.base, remote)));
            } else if (!remote) {
                next.calendar.suppressed = true;
                next.isDeleted = false; // Explicit restore creates a new generation below.
            }
            const outbox = new ExternalEffectOutbox(this.db, { accountId: () => accountId, execute: async () => ({}), now: this.now });
            await outbox.supersedeCalendarEffects(publicId, accountId);
            await this.save(next, current);
            if (choice === 'battleplan') {
                const saved = await this.db.tasks.where('publicId').equals(publicId).first();
                await new TaskMutationService(this.db, { now: this.now }).queueEffects({ publicId,
                    expectedRevision: saved?.protocolRevision?.revision_id ?? null, context: context(accountId, 'ui'),
                    effects: [{ kind: 'calendar', operation: saved?.isDeleted ? 'delete' : 'upsert' }] });
            }
            if (!capture.current()) throw new Error('Přihlášení ke Kalendáři se změnilo.');
            this.notify(); return 'resolved';
        });
    }
    async restoreTaskBlock(publicId: string): Promise<void> {
        const capture = this.capture(), accountId = capture.session.accountId!;
        await this.db.transaction('rw', taskMutationTables(this.db), async () => {
            const task = await this.db.tasks.where('publicId').equals(publicId).first();
            if (!capture.current() || task?.type !== 'task' || task.isDeleted || !task.calendar?.suppressed
                || task.calendar.accountId !== accountId || task.calendar.conflict || task.calendar.readonlyReason)
                throw new Error('Blok úkolu nyní nelze obnovit.');
            await new ExternalEffectOutbox(this.db, { accountId: () => accountId, execute: async () => ({}), now: this.now })
                .supersedeCalendarEffects(publicId, accountId);
            await new TaskMutationService(this.db, { now: this.now }).queueEffects({ publicId,
                expectedRevision: task.protocolRevision?.revision_id ?? null, context: context(accountId, 'ui'),
                effects: [{ kind: 'calendar', operation: 'upsert' }] });
            if (!capture.current()) throw new Error('Přihlášení ke Kalendáři se změnilo.');
        });
        this.notify();
    }
}
