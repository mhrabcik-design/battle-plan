declare global {
    interface Window {
        gapi: any;
        google: any;
    }
}

const CLIENT_ID = '216787355892-u9htv12p0b798vcc702h1qmfpppcc7m0.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/tasks';

export interface GoogleAuthStatus {
    isSignedIn: boolean;
    accessToken: string | null;
}

class GoogleService {
    private tokenClient: any = null;
    private accessToken: string | null = null;

    constructor() {
        this.accessToken = localStorage.getItem('google_access_token');
    }

    async init() {
        return new Promise<void>((resolve) => {
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
                            detail: { isSignedIn: true, accessToken: this.accessToken }
                        }));
                    }
                    resolve();
                });
            };

            const gisLoad = () => {
                this.tokenClient = window.google.accounts.oauth2.initTokenClient({
                    client_id: CLIENT_ID,
                    scope: SCOPES,
                    callback: (response: any) => {
                        if (response.error !== undefined) {
                            throw response;
                        }
                        this.accessToken = response.access_token;
                        localStorage.setItem('google_access_token', response.access_token);
                        window.gapi.client.setToken({ access_token: response.access_token });
                        window.dispatchEvent(new CustomEvent('google-auth-change', {
                            detail: { isSignedIn: true, accessToken: this.accessToken }
                        }));
                    },
                });
            };

            // Poll until scripts are loaded
            const checkScripts = setInterval(() => {
                if (window.gapi && window.google?.accounts?.oauth2) {
                    clearInterval(checkScripts);
                    gapiLoad();
                    gisLoad();
                }
            }, 100);
        });
    }

    getAuthStatus(): GoogleAuthStatus {
        return {
            isSignedIn: !!this.accessToken,
            accessToken: this.accessToken
        };
    }

    signIn() {
        if (this.tokenClient) {
            this.tokenClient.requestAccessToken({ prompt: '' });
        }
    }

    signOut() {
        this.accessToken = null;
        localStorage.removeItem('google_access_token');
        window.dispatchEvent(new CustomEvent('google-auth-change', {
            detail: { isSignedIn: false, accessToken: null }
        }));
    }

    // Google Tasks Methods
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
            const task: any = {
                title,
                notes
            };
            if (dueDate) {
                task.due = new Date(dueDate).toISOString();
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

    async addToCalendar(task: any) {
        if (!this.accessToken) return;

        try {
            const event = {
                'summary': `[BITEVNÍ PLÁN] ${task.title}`,
                'description': `${task.description}\n\nInterní poznámky:\n${task.internalNotes || ''}`,
                'start': {
                    'dateTime': (() => {
                        const dateStr = task.date || task.deadline || new Date().toISOString().split('T')[0];
                        const timeStr = task.startTime || "09:00";
                        return new Date(`${dateStr}T${timeStr}:00`).toISOString();
                    })(),
                    'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
                },
                'end': {
                    'dateTime': (() => {
                        const dateStr = task.date || task.deadline || new Date().toISOString().split('T')[0];
                        const timeStr = task.startTime || "09:00";
                        const baseDate = new Date(`${dateStr}T${timeStr}:00`);
                        const duration = Number(task.duration) || Number(task.totalDuration) || 60;
                        return new Date(baseDate.getTime() + duration * 60000).toISOString();
                    })(),
                    'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
                }
            };

            const method = task.googleEventId ? 'update' : 'insert';
            const params: any = {
                'calendarId': 'primary',
                'resource': event,
            };
            if (task.googleEventId) params.eventId = task.googleEventId;

            const response = await window.gapi.client.calendar.events[method](params);
            return response.result.id;
        } catch (err: any) {
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
        } catch (err: any) {
            console.error('Error deleting calendar event', err);
            if (err?.status === 401 || err?.result?.error?.status === 'UNAUTHENTICATED') {
                this.signOut();
                throw new Error("Relace vypršela. Přihlaste se znovu.");
            }
            const errorMsg = err?.result?.error?.message || err?.message || "Neznámá chyba Googlu";
            throw new Error(`Kalendář smazání selhalo: ${errorMsg}`);
        }
    }

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
            return true;
        } catch (err: any) {
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
