/* eslint-disable @typescript-eslint/no-explicit-any */
import type { GoogleAuthState, GoogleAuthStatus, GoogleTaskRaw } from '../types';
export type { GoogleAuthState, GoogleAuthStatus };

declare global {
    interface Window {
        gapi: {
            load: (apiName: string, callback: () => void) => void;
            client: {
                init: (args: { apiKey: string; discoveryDocs: string[] }) => Promise<void>;
                setToken: (token: { access_token: string } | null) => void;
                tasks: {
                    tasklists: { list: () => Promise<{ result: { items?: any[] } }> };
                    tasks: {
                        list: (args: { tasklist: string; showCompleted?: boolean; showHidden?: boolean; pageToken?: string }) => Promise<{ result: { items?: GoogleTaskRaw[]; nextPageToken?: string } }>;
                        insert: (args: { tasklist: string; resource: unknown }) => Promise<{ result: unknown }>;
                        patch: (args: { tasklist: string; task: string; resource: unknown }) => Promise<{ result: unknown }>;
                        delete: (args: { tasklist: string; task: string }) => Promise<void>;
                    };
                };
                calendar: {
                    events: {
                        insert: (args: { calendarId: string; resource: unknown; eventId?: string }) => Promise<{ result: { id: string } }>;
                        update: (args: { calendarId: string; resource: unknown; eventId?: string }) => Promise<{ result: { id: string } }>;
                        delete: (args: { calendarId: string; eventId: string }) => Promise<void>;
                    };
                };
                drive: {
                    files: {
                        list: (args: { spaces: string; q: string; fields: string; pageSize: number }) => Promise<{ result: { files: Array<{ id: string; name: string }> } }>;
                    };
                };
                request: (args: { path: string; method: string; headers: Record<string, string>; body: string | FormData | Blob | ArrayBufferView | ArrayBuffer | URLSearchParams | ReadableStream | string }) => Promise<{ status: number; statusText?: string; body?: string }>;
            };
        };
        google: {
            accounts: {
                oauth2: {
                    initTokenClient: (config: { client_id: string; scope: string; callback: (response: TokenResponse) => void; error_callback?: (err: unknown) => void; prompt?: string; include_granted_scopes?: boolean }) => TokenClient;
                    hasGrantedAllScopes?: (tokenResponse: TokenResponse, firstScope: string, ...restScopes: string[]) => boolean;
                };
            };
        };
    }
}

interface TokenClient {
    requestAccessToken(options?: { prompt?: string; login_hint?: string | null; scope?: string; include_granted_scopes?: boolean }): void;
}

interface TokenResponse {
    error?: string;
    access_token: string;
    expires_in?: number;
    scope?: string;
}

const CLIENT_ID = (import.meta as { env?: { VITE_GOOGLE_CLIENT_ID?: string } }).env?.VITE_GOOGLE_CLIENT_ID || '216787355892-u9htv12p0b798vcc702h1qmfpppcc7m0.apps.googleusercontent.com';
// Scopes: include OpenID email/profile for oauth2/v3/userinfo and full drive
// instead of drive.file so BP can read agent-suggestions.json written by
// external agents (e.g. Anu bp_suggestions.py). Re-authorization required
// after this scope set changes.
const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
/** Exact scope required by the isolated v2 interoperability probe and later cutover. */
export const AGENT_PROTOCOL_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file' as const;
// Legacy v1 Drive/Suggestions still uses the broader grant until dual-read/single-write cutover.
// The v2 transport must not treat this existing token as proof that the drive.file probe passed.
const CORE_SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive';
const SCOPES = `${CORE_SCOPES} ${GOOGLE_TASKS_SCOPE}`;
const CORE_SCOPE_SET = CORE_SCOPES.split(/\s+/).filter(Boolean);

/** Returns the next YYYY-MM-DD without converting through the browser's local timezone. */
export function getFollowingCivilDate(date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`Neplatné kalendářní datum: ${date}`);
    }

    const value = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== date) {
        throw new Error(`Neplatné kalendářní datum: ${date}`);
    }

    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
}

function tokenHasScopes(response: TokenResponse, scopes: string[]): boolean | null {
    if (response.scope) {
        const granted = new Set(response.scope.split(/\s+/).filter(Boolean));
        return scopes.every(scope => granted.has(scope));
    }

    const [firstScope, ...restScopes] = scopes;
    if (firstScope && window.google?.accounts?.oauth2?.hasGrantedAllScopes) {
        return window.google.accounts.oauth2.hasGrantedAllScopes(response, firstScope, ...restScopes);
    }

    return null;
}

function tokenHasCoreScopes(response: TokenResponse): boolean {
    return tokenHasScopes(response, CORE_SCOPE_SET) !== false;
}

function tokenHasGoogleTasksScope(response: TokenResponse): boolean {
    return tokenHasScopes(response, [GOOGLE_TASKS_SCOPE]) === true;
}

function isUnauthenticatedError(e: unknown): boolean {
    const err = e as { status?: number; result?: { error?: { status?: string; code?: number; message?: string } }; code?: number; message?: string };
    return err?.status === 401 || err?.result?.error?.status === 'UNAUTHENTICATED';
}

function isInsufficientScopeError(e: unknown): boolean {
    const err = e as { status?: number; result?: { error?: { status?: string; code?: number; message?: string } }; code?: number; message?: string };
    if (err?.status === 403) return true;
    if (err?.result?.error?.status === 'PERMISSION_DENIED') return true;
    if (err?.result?.error?.code === 403) return true;
    return /insufficient|scope|permission_denied/i.test(err?.result?.error?.message ?? err?.message ?? '');
}

class GoogleService {
    private tokenClient: TokenClient | null = null;
    private accessToken: string | null = null;
    private expiresAt: number = 0;
    private userEmail: string | null = null;
    private previousStatus: GoogleAuthStatus | null = null;
    private refreshInFlight: Promise<boolean> | null = null;
    private lastRefreshFailedAt: number | null = null;
    private signInInFlight: Promise<void> | null = null;
    private googleTasksScopeAvailable = true;
    private readonly refreshTimeoutMs: number;

    constructor(options: { refreshTimeoutMs?: number } = {}) {
        this.refreshTimeoutMs = options.refreshTimeoutMs ?? 8000;
        this.accessToken = localStorage.getItem('google_access_token');
        this.expiresAt = Number(localStorage.getItem('google_token_expires_at')) || 0;
        this.userEmail = localStorage.getItem('google_user_email');
    }

    async init() {
        return new Promise<void>((resolve, reject) => {
            const gapiLoad = () => {
                window.gapi.load('client', async () => {
                    await window.gapi.client.init({
                        apiKey: '',
                        discoveryDocs: [
                            'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
                            'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
                            'https://tasks.googleapis.com/$discovery/rest?version=v1'
                        ],
                    });

                    if (this.accessToken) {
                        window.gapi.client.setToken({ access_token: this.accessToken });
                        this.dispatchAuthChange();
                    }
                    resolve();
                });
            };

            const gisLoad = () => {
                this.tokenClient = window.google.accounts.oauth2.initTokenClient({
                    client_id: CLIENT_ID,
                    scope: SCOPES,
                    callback: this.handleTokenResponse,
                    error_callback: () => {
                        this.markAuthUnavailable();
                    },
                });
            };

            const SCRIPT_LOAD_TIMEOUT = 15000;
            let resolved = false;

            const checkScripts = setInterval(() => {
                if (window.gapi && window.google?.accounts?.oauth2) {
                    clearInterval(checkScripts);
                    resolved = true;
                    gapiLoad();
                    gisLoad();
                }
            }, 100);

            setTimeout(() => {
                if (!resolved) {
                    clearInterval(checkScripts);
                    reject(new Error('Google scripts failed to load within timeout'));
                }
            }, SCRIPT_LOAD_TIMEOUT);
        });
    }

    /** U6: public single-flight accessor for the init-time silent refresh. */
    async runRefresh(): Promise<boolean> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        const promise = this.trySilentRefresh().finally(() => {
            this.refreshInFlight = null;
        });
        this.refreshInFlight = promise;
        return promise;
    }

    async trySilentRefresh() {
        if (!this.tokenClient || !this.userEmail) return false;

        return new Promise<boolean>((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const done = (result: boolean) => {
                if (settled) return;
                settled = true;
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (result) {
                    this.lastRefreshFailedAt = null;
                } else {
                    this.lastRefreshFailedAt = Date.now();
                }
                resolve(result);
            };

            // Pre-schedule the fallback timer so a throw from initTokenClient still
            // produces a settled promise (U2 fix).
            timer = setTimeout(() => done(false), this.refreshTimeoutMs);

            let singleUseClient: TokenClient;
            try {
                singleUseClient = window.google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                callback: (response: TokenResponse) => {
                    if (response.error !== undefined) {
                        done(false);
                        return;
                    }
                    if (!response.access_token) {
                        // Empty access_token (malformed response) must not be
                        // persisted (U2 fix).
                        done(false);
                        return;
                    }
                    if (!tokenHasCoreScopes(response)) {
                        console.warn('Silent refresh returned a token missing core scopes', { grantedScopes: response.scope, requiredScopes: CORE_SCOPES });
                        done(false);
                        return;
                    }
                    this.googleTasksScopeAvailable = tokenHasGoogleTasksScope(response);
                    this.accessToken = response.access_token;
                    const expiresIn = response.expires_in || 3600;
                    this.expiresAt = Date.now() + (expiresIn * 1000);

                    localStorage.setItem('google_access_token', response.access_token);
                    localStorage.setItem('google_token_expires_at', this.expiresAt.toString());

                    try {
                        window.gapi.client.setToken({ access_token: response.access_token });
                    } catch (setTokenErr) {
                        // U2 fix: setToken throw leaves localStorage updated
                        // but gapi.client without a bearer. Flip to OFFLINE_AUTH
                        // so the user can re-grant from Settings.
                        console.error('gapi.client.setToken failed on silent refresh', setTokenErr);
                        this.markAuthUnavailable();
                        done(false);
                        return;
                    }

                    this.dispatchAuthChange();

                    done(true);
                },
                error_callback: () => done(false),
            });
            } catch (initErr) {
                console.error('initTokenClient failed', initErr);
                done(false);
                return;
            }

            try {
                singleUseClient.requestAccessToken({
                    prompt: 'none',
                    login_hint: this.userEmail
                });
            } catch (err) {
                console.error('Silent refresh failed', err);
                done(false);
            }


        });
    }

    async fetchUserInfo() {
        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            if (!response.ok) return;
            const data = await response.json();
            if (data.email) {
                this.userEmail = data.email;
                localStorage.setItem('google_user_email', data.email);
            }
        } catch (e) {
            console.error('Failed to fetch user info', e);
        }
    }

    getAuthStatus(): GoogleAuthStatus {
        return {
            state: this.getAuthState(),
            accessToken: this.accessToken
        };
    }

    getAccountId(): string | null {
        return this.userEmail;
    }

    private dispatchAuthChange() {
        const status = this.getAuthStatus();
        if (
            this.previousStatus &&
            this.previousStatus.state === status.state &&
            this.previousStatus.accessToken === status.accessToken
        ) {
            return;
        }
        this.previousStatus = status;
        window.dispatchEvent(new CustomEvent('google-auth-change', { detail: status }));
    }

    private markAuthUnavailable(): void {
        // INTENTIONAL ASYMMETRY: null the in-memory accessToken + gapi client so
        // the rest of the app sees OFFLINE_AUTH immediately, but KEEP the
        // localStorage['google_access_token'] entry. The next signIn() can
        // attempt a refresh against the same stored token, which is the
        // behavior that prevents the "401 nukes credentials" regression: a
        // transient 401 must not erase the user's stored grant. The user
        // can still clear it explicitly via Settings > Odpojit.
        this.lastRefreshFailedAt = Date.now();
        this.accessToken = null;
        try {
            if (window.gapi?.client) {
                window.gapi.client.setToken(null);
            }
        } catch (e) {
            console.error('Failed to clear gapi client token on auth unavailability', e);
        }
        this.dispatchAuthChange();
    }

    getAuthState(): GoogleAuthState {
        if (!this.accessToken) {
            if (this.userEmail !== null && this.lastRefreshFailedAt !== null) {
                return 'OFFLINE_AUTH';
            }
            return 'SIGNED_OUT';
        }
        const isExpired = Date.now() > (this.expiresAt - 60000);
        if (isExpired) {
            return 'REFRESH_PENDING';
        }
        return 'SIGNED_IN';
    }

    private async ensureFreshToken(): Promise<'ok' | 'auth-unavailable'> {
        const state = this.getAuthState();
        if (state === 'SIGNED_IN') return 'ok';
        if (state === 'REFRESH_PENDING') {
            let refreshed = false;
            try {
                refreshed = await this.runRefresh();
            } catch {
                // U2: runRefresh/trySilentRefresh should never reject, but if a
                // future change makes it possible we must still transition the
                // state machine rather than leak a rejection to the caller.
                refreshed = false;
            }
            if (refreshed && this.getAuthState() === 'SIGNED_IN') return 'ok';
            // U1 fix: a failed or post-refresh-non-SIGNED_IN state must
            // transition to OFFLINE_AUTH so the user can re-grant from Settings.
            // Otherwise the singleton stays in REFRESH_PENDING forever and the
            // sync icon never flips to failed.
            this.markAuthUnavailable();
            return 'auth-unavailable';
        }
        return 'auth-unavailable';
    }

    signIn(): Promise<void> {
        // U5: single-flight. A double-click on 'Sign in' does not produce two
        // GIS prompts; the second call awaits the in-flight promise.
        if (this.signInInFlight) return this.signInInFlight;
        const promise = (async () => {
            // Always force the user-visible request itself through the consent
            // flow. GIS treats requestAccessToken(options) as an override of
            // initTokenClient config; passing { prompt: '' } here suppresses
            // the consent prompt for returning users and can hand us an access
            // token with the OLD scope set. That is exactly the production
            // failure: user clicks Google Přihlášení, a token arrives, then
            // Tasks API returns 403 PERMISSION_DENIED and the state snaps back
            // to IDLE. Keep prompt='consent' on both init and request.
            const consentClient = window.google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                prompt: 'consent',
                include_granted_scopes: false,
                callback: this.handleTokenResponse,
                error_callback: () => {
                    this.markAuthUnavailable();
                },
            });
            consentClient.requestAccessToken({
                prompt: 'consent',
                scope: SCOPES,
                include_granted_scopes: false,
            });
        })().finally(() => {
            this.signInInFlight = null;
        });
        this.signInInFlight = promise;
        return promise;
    }
    private handleTokenResponse = (response: TokenResponse) => {
        this.lastRefreshFailedAt = null;
        if (response.error !== undefined) {
            console.error('GIS Error:', response);
            return;
        }
        if (!response.access_token) {
            // Empty access_token (malformed response) must not be persisted
            // (U2 fix).
            return;
        }
        if (!tokenHasCoreScopes(response)) {
            console.warn('Consent returned a token missing core scopes', { grantedScopes: response.scope, requiredScopes: CORE_SCOPES });
            this.markAuthUnavailable();
            return;
        }
        this.googleTasksScopeAvailable = tokenHasGoogleTasksScope(response);
        this.accessToken = response.access_token;
        const expiresIn = response.expires_in || 3600;
        this.expiresAt = Date.now() + (expiresIn * 1000);

        localStorage.setItem('google_access_token', response.access_token);
        localStorage.setItem('google_token_expires_at', this.expiresAt.toString());

        try {
            window.gapi.client.setToken({ access_token: response.access_token });
        } catch (setTokenErr) {
            // U2 fix: setToken throw leaves localStorage updated but
            // gapi.client without a bearer. Flip to OFFLINE_AUTH so the
            // user can re-grant from Settings.
            console.error('gapi.client.setToken failed on consent', setTokenErr);
            this.markAuthUnavailable();
            return;
        }

        if (!this.userEmail) {
            void this.fetchUserInfo();
        }

        this.dispatchAuthChange();
    };

    signOut() {
        if (this.accessToken) {
            fetch(`https://oauth2.googleapis.com/revoke?token=${this.accessToken}`, { method: 'POST' }).catch(() => {});
        }

        try {
            if (window.gapi?.client) {
                window.gapi.client.setToken(null);
            }
        } catch (e) {
            console.error('Sign out error:', e);
        }

        this.accessToken = null;
        this.expiresAt = 0;
        this.userEmail = null;
        this.lastRefreshFailedAt = null;
        this.googleTasksScopeAvailable = false;
        localStorage.removeItem('google_access_token');
        localStorage.removeItem('google_token_expires_at');
        localStorage.removeItem('google_user_email');
        this.dispatchAuthChange();
    }

    async getTaskLists() {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return [];
        if (!this.googleTasksScopeAvailable) return [];
        try {
            const response = await window.gapi.client.tasks.tasklists.list();
            return response.result.items || [];
        } catch (e: unknown) {
            if (isUnauthenticatedError(e)) {
                this.markAuthUnavailable();
                return [];
            }
            if (isInsufficientScopeError(e)) {
                this.googleTasksScopeAvailable = false;
                console.warn('Google Tasks scope unavailable; keeping Google auth active', e);
                return [];
            }
            console.error('Error fetching task lists', e);
            return [];
        }
    }

    async getTasks(taskListId: string = '@default') {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return [];
        if (!this.googleTasksScopeAvailable) return [];
        try {
            const tasks: GoogleTaskRaw[] = [];
            let pageToken: string | undefined;

            do {
                const request: { tasklist: string; showCompleted: boolean; showHidden: boolean; pageToken?: string } = {
                    tasklist: taskListId,
                    showCompleted: true,
                    showHidden: true,
                };
                if (pageToken) request.pageToken = pageToken;

                const response = await window.gapi.client.tasks.tasks.list(request);
                tasks.push(...(response.result.items || []));
                pageToken = response.result.nextPageToken;
            } while (pageToken);

            return tasks;
        } catch (e: unknown) {
            if (isUnauthenticatedError(e)) {
                this.markAuthUnavailable();
                return [];
            }
            if (isInsufficientScopeError(e)) {
                this.googleTasksScopeAvailable = false;
                console.warn('Google Tasks scope unavailable; keeping Google auth active', e);
                return [];
            }
            console.error('Error fetching tasks', e);
            return [];
        }
    }

    async createGoogleTask(title: string, notes: string = '', taskListId: string = '@default', dueDate?: string) {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return null;
        if (!this.googleTasksScopeAvailable) return null;
        try {
            const task: Record<string, unknown> = { title, notes };
            if (dueDate) {
                const d = new Date(dueDate);
                if (!isNaN(d.getTime())) {
                    task.due = d.toISOString();
                }
            }
            const response = await window.gapi.client.tasks.tasks.insert({
                tasklist: taskListId,
                resource: task
            });
            return response.result;
        } catch (e: unknown) {
            if (isUnauthenticatedError(e)) {
                this.markAuthUnavailable();
                return null;
            }
            if (isInsufficientScopeError(e)) {
                this.googleTasksScopeAvailable = false;
                console.warn('Google Tasks scope unavailable; keeping Google auth active', e);
                return null;
            }
            console.error('Error creating Google Task', e);
            return null;
        }
    }

    async updateGoogleTask(taskId: string, updates: Record<string, unknown>, taskListId: string = '@default') {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return null;
        if (!this.googleTasksScopeAvailable) return null;
        try {
            const response = await window.gapi.client.tasks.tasks.patch({
                tasklist: taskListId,
                task: taskId,
                resource: updates
            });
            return response.result;
        } catch (e: unknown) {
            if (isUnauthenticatedError(e)) {
                this.markAuthUnavailable();
                return null;
            }
            if (isInsufficientScopeError(e)) {
                this.googleTasksScopeAvailable = false;
                console.warn('Google Tasks scope unavailable; keeping Google auth active', e);
                return null;
            }
            console.error('Error updating Google Task', e);
            return null;
        }
    }

    async deleteGoogleTask(taskId: string, taskListId: string = '@default'): Promise<boolean> {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return false;
        if (!this.googleTasksScopeAvailable) return false;
        try {
            await window.gapi.client.tasks.tasks.delete({
                tasklist: taskListId,
                task: taskId
            });
            return true;
        } catch (e: unknown) {
            if (isUnauthenticatedError(e)) {
                this.markAuthUnavailable();
                return false;
            }
            if (isInsufficientScopeError(e)) {
                this.googleTasksScopeAvailable = false;
                console.warn('Google Tasks scope unavailable; keeping Google auth active', e);
                return false;
            }
            console.error('Error deleting Google Task', e);
            return false;
        }
    }

    async addToCalendar(task: any) {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return;

        try {
            const dateStr = task.date || task.deadline || new Date().toISOString().split('T')[0];
            const isAllDay = task.isAllDay === true;

            // Pro timed event potřebujeme i čas
            const timeStr = task.startTime || "09:00";
            const baseDate = new Date(`${dateStr}T${timeStr}:00`);
            if (!isAllDay && isNaN(baseDate.getTime())) throw new Error("Neplatné datum/čas pro kalendář");

            const duration = task.duration != null ? Number(task.duration) : (task.totalDuration != null ? Number(task.totalDuration) : 60);

            // Výpočet pro upozornění v 8:00 ráno daný den
            const eightAmDate = new Date(`${dateStr}T08:00:00`);
            const minutesBefore8AM = Math.floor((baseDate.getTime() - eightAmDate.getTime()) / 60000);

            const overrides: any[] = [];

            if (task.status !== 'completed') {
                overrides.push({ method: 'popup', minutes: 24 * 60 }); // 24 hodin předem
                if (!isAllDay && minutesBefore8AM >= 0) {
                    overrides.push({ method: 'popup', minutes: minutesBefore8AM });
                }
            }

            // All-day event vs timed event mají jinou strukturu
            const event: any = {
                'summary': `${task.title} [BP]`,
                'description': `${task.description}\n\nInterní poznámky:\n${task.internalNotes || ''}`,
            };

            if (isAllDay) {
                // Google all-day: start.date = YYYY-MM-DD, end.date je EXKLUZIVNÍ (den po)
                event.start = { 'date': dateStr };
                event.end = { 'date': getFollowingCivilDate(dateStr) };
            } else {
                event.start = {
                    'dateTime': baseDate.toISOString(),
                    'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
                };
                event.end = {
                    'dateTime': new Date(baseDate.getTime() + duration * 60000).toISOString(),
                    'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
                };
            }

            event.reminders = {
                'useDefault': false,
                'overrides': overrides
            };

            const method = task.googleEventId ? 'update' : 'insert';

            const params: any = {
                'calendarId': 'primary',
                'resource': event,
            };
            if (task.googleEventId) params.eventId = task.googleEventId;

            const response = await window.gapi.client.calendar.events[method](params);
            return response.result.id;
        } catch (e: unknown) {
            const err = e as { status?: number; result?: { error?: { status?: string; message?: string } }; message?: string };
            console.error('Error creating calendar event', err);
            if (isUnauthenticatedError(e)) {
                this.markAuthUnavailable();
                return;
            }
            const errorMsg = err?.result?.error?.message || err?.message || JSON.stringify(err);
            throw new Error(`Google Calendar Error: ${errorMsg}`);
        }
    }

    async deleteFromCalendar(eventId: string) {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return;
        try {
            await window.gapi.client.calendar.events.delete({
                'calendarId': 'primary',
                'eventId': eventId
            });
            return true;
        } catch (e: unknown) {
            const err = e as { status?: number; result?: { error?: { status?: string; message?: string } }; message?: string };
            console.error('Error deleting calendar event', err);
            if (isUnauthenticatedError(e)) {
                this.markAuthUnavailable();
                return;
            }
            const errorMsg = err?.result?.error?.message || err?.message || "Neznámá chyba Googlu";
            throw new Error(`Kalendář smazání selhalo: ${errorMsg}`);
        }
    }

}

export class AuthUnavailableError extends Error {
    readonly code = 'AUTH_UNAVAILABLE' as const;

    constructor(message: string) {
        super(message);
        this.name = 'AuthUnavailableError';
    }
}

export const googleService = new GoogleService();

export { GoogleService };
