/* eslint-disable @typescript-eslint/no-explicit-any */
import type { GoogleAuthState, GoogleAuthStatus } from '../types';
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
                        list: (args: { tasklist: string; showCompleted?: boolean; showHidden?: boolean }) => Promise<{ result: { items?: any[] } }>;
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
                    initTokenClient: (config: { client_id: string; scope: string; callback: (response: TokenResponse) => void; error_callback?: () => void; prompt?: string; include_granted_scopes?: string }) => TokenClient;
                };
            };
        };
    }
}

interface TokenClient {
    requestAccessToken(options?: { prompt?: string; login_hint?: string | null }): void;
}

interface TokenResponse {
    error?: string;
    access_token: string;
    expires_in?: number;
}

const CLIENT_ID = (import.meta as { env?: { VITE_GOOGLE_CLIENT_ID?: string } }).env?.VITE_GOOGLE_CLIENT_ID || '216787355892-u9htv12p0b798vcc702h1qmfpppcc7m0.apps.googleusercontent.com';
// Scopes: drive (full) instead of drive.file so BP app can read agent-suggestions.json
// that was written by external agents (e.g. Anu bp_suggestions.py). The full drive
// scope also includes drive.file semantics, so existing files remain accessible.
// Re-authorization required after this change.
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/tasks';

class GoogleService {
    private tokenClient: TokenClient | null = null;
    private accessToken: string | null = null;
    private expiresAt: number = 0;
    private userEmail: string | null = null;
    private previousStatus: GoogleAuthStatus | null = null;
    private refreshInFlight: Promise<boolean> | null = null;
    private lastRefreshFailedAt: number | null = null;

    constructor() {
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

    private async runRefresh(): Promise<boolean> {
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

            const done = (result: boolean) => {
                if (settled) return;
                settled = true;
                if (result) {
                    this.lastRefreshFailedAt = null;
                } else {
                    this.lastRefreshFailedAt = Date.now();
                }
                resolve(result);
            };

            const singleUseClient = window.google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                callback: (response: TokenResponse) => {
                    if (response.error !== undefined) {
                        done(false);
                        return;
                    }
                    this.accessToken = response.access_token || null;
                    const expiresIn = response.expires_in || 3600;
                    this.expiresAt = Date.now() + (expiresIn * 1000);

                    localStorage.setItem('google_access_token', response.access_token);
                    localStorage.setItem('google_token_expires_at', this.expiresAt.toString());

                    window.gapi.client.setToken({ access_token: response.access_token });

                    this.dispatchAuthChange();

                    done(true);
                },
                error_callback: () => done(false),
            });

            try {
                singleUseClient.requestAccessToken({
                    prompt: 'none',
                    login_hint: this.userEmail
                });
            } catch (err) {
                console.error('Silent refresh failed', err);
                done(false);
            }

            setTimeout(() => done(false), 5000);
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
            const refreshed = await this.runRefresh();
            if (refreshed) {
                if (this.getAuthState() === 'SIGNED_IN') return 'ok';
                return 'auth-unavailable';
            }
            return 'auth-unavailable';
        }
        return 'auth-unavailable';
    }

    signIn() {
        const userEmail = localStorage.getItem('google_user_email');
        const isFirstSignIn = userEmail === null;

        if (isFirstSignIn) {
            const consentClient = window.google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                prompt: 'consent',
                include_granted_scopes: 'true',
                callback: this.handleTokenResponse,
            });
            consentClient.requestAccessToken({ prompt: '' });
            return;
        }

        if (this.tokenClient) {
            const options: { prompt?: string; login_hint?: string | null } = { prompt: '' };
            if (this.userEmail) options.login_hint = this.userEmail;
            this.tokenClient.requestAccessToken(options);
        }
    }

    private handleTokenResponse = (response: TokenResponse) => {
        this.lastRefreshFailedAt = null;
        if (response.error !== undefined) {
            console.error('GIS Error:', response);
            return;
        }
        this.accessToken = response.access_token || null;
        const expiresIn = response.expires_in || 3600;
        this.expiresAt = Date.now() + (expiresIn * 1000);

        localStorage.setItem('google_access_token', response.access_token);
        localStorage.setItem('google_token_expires_at', this.expiresAt.toString());

        window.gapi.client.setToken({ access_token: response.access_token });

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
        localStorage.removeItem('google_access_token');
        localStorage.removeItem('google_token_expires_at');
        localStorage.removeItem('google_user_email');
        this.dispatchAuthChange();
    }

    async getTaskLists() {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return [];
        try {
            const response = await window.gapi.client.tasks.tasklists.list();
            return response.result.items || [];
        } catch (err) {
            console.error('Error fetching task lists', err);
            return [];
        }
    }

    async getTasks(taskListId: string = '@default') {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return [];
        try {
            const response = await window.gapi.client.tasks.tasks.list({
                tasklist: taskListId,
                showCompleted: true,
                showHidden: true
            });
            return response.result.items || [];
        } catch (err) {
            console.error('Error fetching tasks', err);
            return [];
        }
    }

    async createGoogleTask(title: string, notes: string = '', taskListId: string = '@default', dueDate?: string) {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return null;
        try {

            const task: any = { title, notes };
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
        } catch (err) {
            console.error('Error creating Google Task', err);
            return null;
        }
    }


    async updateGoogleTask(taskId: string, updates: any, taskListId: string = '@default') {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return null;
        try {
            const response = await window.gapi.client.tasks.tasks.patch({
                tasklist: taskListId,
                task: taskId,
                resource: updates
            });
            return response.result;
        } catch (err) {
            console.error('Error updating Google Task', err);
            return null;
        }
    }

    async deleteGoogleTask(taskId: string, taskListId: string = '@default') {
        if ((await this.ensureFreshToken()) === 'auth-unavailable') return;
        try {
            await window.gapi.client.tasks.tasks.delete({
                tasklist: taskListId,
                task: taskId
            });
        } catch (err) {
            console.error('Error deleting Google Task', err);
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
                const endDate = new Date(`${dateStr}T00:00:00`);
                endDate.setDate(endDate.getDate() + 1);
                const endDateStr = endDate.toISOString().split('T')[0];
                event.start = { 'date': dateStr };
                event.end = { 'date': endDateStr };
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
            if (err?.status === 401 || err?.result?.error?.status === 'UNAUTHENTICATED') {
                this.lastRefreshFailedAt = Date.now();
                this.dispatchAuthChange();
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
            if (err?.status === 401 || err?.result?.error?.status === 'UNAUTHENTICATED') {
                this.lastRefreshFailedAt = Date.now();
                this.dispatchAuthChange();
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
