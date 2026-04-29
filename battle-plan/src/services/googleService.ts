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
                request: (args: { path: string; method: string; headers: Record<string, string>; body: string | FormData | Blob | ArrayBufferView | ArrayBuffer | URLSearchParams | ReadableStream | string }) => Promise<{ status: number; statusText?: string }>;
            };
        };
        google: {
            accounts: {
                oauth2: {
                    initTokenClient: (config: { client_id: string; scope: string; callback: (response: TokenResponse) => void; error_callback?: () => void }) => TokenClient;
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

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '216787355892-u9htv12p0b798vcc702h1qmfpppcc7m0.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/tasks';

export interface GoogleAuthStatus {
    isSignedIn: boolean;
    accessToken: string | null;
}

class GoogleService {
    private tokenClient: TokenClient | null = null;
    private accessToken: string | null = null;
    private expiresAt: number = 0;
    private userEmail: string | null = null;

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
                        window.dispatchEvent(new CustomEvent('google-auth-change', {
                            detail: this.getAuthStatus()
                        }));
                    }
                    resolve();
                });
            };

            const gisLoad = () => {
                this.tokenClient = window.google.accounts.oauth2.initTokenClient({
                    client_id: CLIENT_ID,
                    scope: SCOPES,
                    callback: (response: TokenResponse) => {
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
                            this.fetchUserInfo();
                        }

                        window.dispatchEvent(new CustomEvent('google-auth-change', {
                            detail: { isSignedIn: true, accessToken: this.accessToken }
                        }));
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

    async trySilentRefresh() {
        if (!this.tokenClient || !this.userEmail) return false;

        return new Promise<boolean>((resolve) => {
            let settled = false;

            const done = (result: boolean) => {
                if (settled) return;
                settled = true;
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

                    window.dispatchEvent(new CustomEvent('google-auth-change', {
                        detail: { isSignedIn: true, accessToken: this.accessToken }
                    }));

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

            setTimeout(() => done(!!this.accessToken), 5000);
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
        const isExpired = Date.now() > (this.expiresAt - 60000);
        return {
            isSignedIn: !!this.accessToken && !isExpired,
            accessToken: this.accessToken
        };
    }

    signIn() {
        if (this.tokenClient) {
            const options: { prompt?: string; login_hint?: string | null } = { prompt: '' };
            if (this.userEmail) options.login_hint = this.userEmail;
            this.tokenClient.requestAccessToken(options);
        }
    }

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
        localStorage.removeItem('google_access_token');
        localStorage.removeItem('google_token_expires_at');
        localStorage.removeItem('google_user_email');
        window.dispatchEvent(new CustomEvent('google-auth-change', {
            detail: { isSignedIn: false, accessToken: null }
        }));
    }

    async getTaskLists() {
        if (!this.accessToken) return [];
        try {
            const response = await window.gapi.client.tasks.tasklists.list();
            return response.result.items || [];
        } catch (err) {
            console.error('Error fetching task lists', err);
            return [];
        }
    }

    async getTasks(taskListId: string = '@default') {
        if (!this.accessToken) return [];
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
        if (!this.accessToken) return null;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async updateGoogleTask(taskId: string, updates: any, taskListId: string = '@default') {
        if (!this.accessToken) return null;
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
        if (!this.accessToken) return;
        try {
            await window.gapi.client.tasks.tasks.delete({
                tasklist: taskListId,
                task: taskId
            });
        } catch (err) {
            console.error('Error deleting Google Task', err);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async addToCalendar(task: any) {
        if (!this.accessToken) return;

        try {
            const dateStr = task.date || task.deadline || new Date().toISOString().split('T')[0];
            const timeStr = task.startTime || "09:00";
            const baseDate = new Date(`${dateStr}T${timeStr}:00`);
            if (isNaN(baseDate.getTime())) throw new Error("Neplatné datum/čas pro kalendář");

            const duration = task.duration != null ? Number(task.duration) : (task.totalDuration != null ? Number(task.totalDuration) : 60);

            const event = {
                'summary': `${task.title} [BP]`,
                'description': `${task.description}\n\nInterní poznámky:\n${task.internalNotes || ''}`,
                'start': {
                    'dateTime': baseDate.toISOString(),
                    'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
                },
                'end': {
                    'dateTime': new Date(baseDate.getTime() + duration * 60000).toISOString(),
                    'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
                }
            };

            const method = task.googleEventId ? 'update' : 'insert';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                this.signOut();
                throw new Error("Relace vypršela. Prosím přihlaste se znovu v nastavení.");
            }
            const errorMsg = err?.result?.error?.message || err?.message || JSON.stringify(err);
            throw new Error(`Google Calendar Error: ${errorMsg}`);
        }
    }

    async deleteFromCalendar(eventId: string) {
        if (!this.accessToken) return;
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
                this.signOut();
                throw new Error("Relace vypršela. Přihlaste se znovu.");
            }
            const errorMsg = err?.result?.error?.message || err?.message || "Neznámá chyba Googlu";
            throw new Error(`Kalendář smazání selhalo: ${errorMsg}`);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveToDrive(data: any) {
        if (!this.accessToken) return;
        try {
            const listResponse = await window.gapi.client.drive.files.list({
                spaces: 'appDataFolder',
                q: "name = 'battle_plan_data.json'",
                fields: 'files(id, name)',
                pageSize: 1
            });

            const existingFile = listResponse.result.files[0];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const metadata: any = {
                name: 'battle_plan_data.json',
                mimeType: 'application/json'
            };
            if (!existingFile) {
                metadata.parents = ['appDataFolder'];
            }

            const payload = {
                version: '1.2',
                timestamp: Date.now(),
                data: data
            };

            const fileContent = JSON.stringify(payload);
            const boundary = '-------314159265358979323846';
            const body =
                "--" + boundary + "\r\n" +
                "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
                JSON.stringify(metadata) + "\r\n" +
                "--" + boundary + "\r\n" +
                "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
                fileContent + "\r\n" +
                "--" + boundary + "--";

            const path = existingFile
                ? `/upload/drive/v3/files/${existingFile.id}?uploadType=multipart`
                : '/upload/drive/v3/files?uploadType=multipart';

            const response = await window.gapi.client.request({
                path: path,
                method: existingFile ? 'PATCH' : 'POST',
                headers: {
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: body
            });

            if (response.status !== 200 && response.status !== 201) {
                throw new Error(`Sync failed: ${response.statusText || response.status}`);
            }
            return payload.timestamp;
        } catch (e: unknown) {
            const err = e as { status?: number; result?: { error?: { status?: string; message?: string } }; message?: string };
            console.error('Error saving to Drive', err);
            if (err?.status === 401 || err?.result?.error?.status === 'UNAUTHENTICATED') {
                this.signOut();
                throw new Error("Relace vypršela. Přihlaste se znovu v nastavení.");
            }
            const msg = err?.result?.error?.message || err?.message || "Chyba synchronizace";
            throw new Error(`Disk Error: ${msg}`);
        }
    }

    async loadFromDrive() {
        if (!this.accessToken) return null;
        try {
            const listResponse = await window.gapi.client.drive.files.list({
                spaces: 'appDataFolder',
                q: "name = 'battle_plan_data.json'",
                fields: 'files(id, name)',
                pageSize: 1
            });
            const existingFile = listResponse.result.files[0];
            if (!existingFile) return null;
            const response = await fetch(`https://www.googleapis.com/drive/v3/files/${existingFile.id}?alt=media`, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            if (!response.ok) return null;
            return await response.json();
        } catch (err) {
            console.error('Error loading from Drive', err);
            return null;
        }
    }
}

export const googleService = new GoogleService();
