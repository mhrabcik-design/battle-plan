declare global {
    interface Window {
        gapi: any;
        google: any;
    }
}

const CLIENT_ID = '216787355892-u9htv12p0b798vcc702h1qmfpppcc7m0.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.appdata';

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
                        apiKey: '', // API key is not strictly needed for GIS token flow if only using client ID
                        discoveryDocs: [
                            'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
                            'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'
                        ],
                    });
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
            this.tokenClient.requestAccessToken({ prompt: 'consent' });
        }
    }

    signOut() {
        this.accessToken = null;
        localStorage.removeItem('google_access_token');
        window.dispatchEvent(new CustomEvent('google-auth-change', {
            detail: { isSignedIn: false, accessToken: null }
        }));
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
                        const timeStr = task.startTime || "09:00"; // Default to 9:00 if not set
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

            // If token is invalid or missing (401), sign out so user can sign in again
            if (err?.status === 401 || err?.result?.error?.status === 'UNAUTHENTICATED') {
                this.signOut();
                throw new Error("Relace vypršela. Prosím přihlaste se znovu v nastavení.");
            }

            const errorMsg = err?.result?.error?.message || err?.message || JSON.stringify(err);
            throw new Error(`Google Calendar Error: ${errorMsg}`);
        }
    }

    async saveToDrive(data: any) {
        if (!this.accessToken) return;

        try {
            // Find existing file in appDataFolder
            const listResponse = await window.gapi.client.drive.files.list({
                spaces: 'appDataFolder',
                fields: 'files(id, name)',
                pageSize: 1
            });

            const existingFile = listResponse.result.files[0];
            const metadata = {
                name: 'battle_plan_backup.json',
                mimeType: 'application/json',
                parents: ['appDataFolder']
            };

            const fileContent = JSON.stringify(data);
            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";

            const body =
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                fileContent +
                close_delim;

            const method = existingFile ? 'PATCH' : 'POST';
            const url = `https://www.googleapis.com/upload/drive/v3/files${existingFile ? '/' + existingFile.id : ''}?uploadType=multipart`;

            await fetch(url, {
                method: method,
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: body
            });

            console.log('Backup saved to Drive');
        } catch (err) {
            console.error('Error saving to Drive', err);
        }
    }

    async loadFromDrive() {
        if (!this.accessToken) return null;

        try {
            const listResponse = await window.gapi.client.drive.files.list({
                spaces: 'appDataFolder',
                fields: 'files(id, name)',
                pageSize: 1
            });

            const existingFile = listResponse.result.files[0];
            if (!existingFile) return null;

            const response = await fetch(`https://www.googleapis.com/drive/v3/files/${existingFile.id}?alt=media`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            return await response.json();
        } catch (err) {
            console.error('Error loading from Drive', err);
            return null;
        }
    }
}

export const googleService = new GoogleService();
