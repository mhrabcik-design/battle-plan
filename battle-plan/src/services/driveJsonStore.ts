const DEFAULT_FOLDER_NAME = 'Anu-BattlePlan';
const DEFAULT_FOLDER_CACHE_KEY = 'bp_folder_id';
const JSON_MIME_TYPE = 'application/json';
const MULTIPART_BOUNDARY = '-------314159265358979323846';

interface DriveFileMeta {
    id: string;
    name?: string;
}

interface DriveUploadResponse {
    body?: string;
    result?: { id?: string };
}

interface GapiDriveClient {
    files: {
        list: (args: { spaces: string; q: string; fields: string; pageSize: number }) => Promise<{ result: { files?: DriveFileMeta[] } }>;
    };
}

interface GapiClient {
    drive?: GapiDriveClient;
    request: (args: { path: string; method: string; headers: Record<string, string>; body: string | Blob }) => Promise<DriveUploadResponse & { status?: number; statusText?: string }>;
}

type WindowWithGapi = typeof window & {
    gapi?: {
        client?: GapiClient;
    };
};

export interface DriveFileMetadata {
    name: string;
    mimeType: string;
    parents?: string[];
}

export interface DriveJsonRead<T> {
    fileId: string;
    data: T;
}

export interface DriveJsonWrite {
    fileId: string | null;
}

export function buildDriveFileMetadata(name: string, mimeType: string, folderId: string, fileId: string | null): DriveFileMetadata {
    const metadata: DriveFileMetadata = { name, mimeType };
    if (!fileId) {
        metadata.parents = [folderId];
    }
    return metadata;
}

export function getUploadedDriveFileId(response: DriveUploadResponse): string | null {
    if (response.result?.id) return response.result.id;
    if (!response.body) return null;
    try {
        const parsed = JSON.parse(response.body) as { id?: string };
        return parsed.id ?? null;
    } catch {
        return null;
    }
}

function escapeDriveQueryValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function ensureDriveRequestOk(response: { status?: number; statusText?: string }, action: string): void {
    const { status } = response;
    if (status !== undefined && (status < 200 || status >= 300)) {
        throw new Error(`${action} failed: ${status} ${response.statusText ?? ''}`.trim());
    }
}

export function buildMultipartJsonBody(metadata: DriveFileMetadata, payload: unknown, boundary = MULTIPART_BOUNDARY): string {
    return '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(payload) + '\r\n' +
        '--' + boundary + '--';
}

export function buildMultipartBlobBody(metadata: DriveFileMetadata, blob: Blob, mimeType: string, boundary = MULTIPART_BOUNDARY): Blob {
    const body =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        `Content-Type: ${mimeType}\r\n\r\n`;
    const head = new TextEncoder().encode(body);
    const tail = new TextEncoder().encode('\r\n--' + boundary + '--');
    return new Blob([head, blob, tail], { type: 'multipart/related' });
}

export class DriveJsonStore {
    private folderId: string | null = null;
    private isInitialized = false;
    private readonly folderName: string;
    private readonly folderCacheKey: string;

    constructor(folderName = DEFAULT_FOLDER_NAME, folderCacheKey = DEFAULT_FOLDER_CACHE_KEY) {
        this.folderName = folderName;
        this.folderCacheKey = folderCacheKey;
    }

    async init(options: { createFolder?: boolean } = {}): Promise<boolean> {
        if (this.isInitialized) return true;
        const client = this.getClient();
        if (!client?.drive) {
            console.warn('DriveJsonStore: GAPI Drive client not available');
            return false;
        }
        if (!this.getAccessToken()) {
            console.warn('DriveJsonStore: Not signed in');
            return false;
        }

        const cached = localStorage.getItem(this.folderCacheKey);
        if (cached) {
            this.folderId = cached;
            this.isInitialized = true;
            return true;
        }

        try {
            const r = await client.drive.files.list({
                q: `name='${escapeDriveQueryValue(this.folderName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                spaces: 'drive',
                fields: 'files(id, name)',
                pageSize: 1,
            });
            if (r.result.files?.[0]) {
                this.folderId = r.result.files[0].id;
                localStorage.setItem(this.folderCacheKey, this.folderId);
                this.isInitialized = true;
                return true;
            }
            if (options.createFolder) {
                this.folderId = await this.createFolder(client);
                localStorage.setItem(this.folderCacheKey, this.folderId);
                this.isInitialized = true;
                return true;
            }
            console.warn(`DriveJsonStore: Folder /${this.folderName}/ not found`);
            return false;
        } catch (e) {
            console.error('DriveJsonStore: Failed to initialize folder', e);
            return false;
        }
    }

    async findFileId(name: string): Promise<string | null> {
        if (!this.isInitialized || !this.folderId) return null;
        const client = this.getClient();
        if (!client?.drive) return null;
        const listR = await client.drive.files.list({
            q: `name='${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(this.folderId)}' in parents and trashed=false`,
            spaces: 'drive',
            fields: 'files(id, name)',
            pageSize: 1,
        });
        return listR.result.files?.[0]?.id ?? null;
    }

    async readJsonFile<T>(name: string): Promise<DriveJsonRead<T> | null> {
        if (!this.isInitialized || !this.folderId) return null;
        const accessToken = this.getAccessToken();
        if (!accessToken) return null;
        const fileId = await this.findFileId(name);
        if (!fileId) return null;

        const resp = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } },
        );
        if (!resp.ok) return null;
        return { fileId, data: await resp.json() as T };
    }

    async writeJsonFile(name: string, payload: unknown, fileId: string | null = null): Promise<DriveJsonWrite | null> {
        if (!this.isInitialized || !this.folderId) return null;
        const client = this.getClient();
        if (!client) return null;
        const targetFileId = fileId ?? await this.findFileId(name);
        const metadata = buildDriveFileMetadata(name, JSON_MIME_TYPE, this.folderId, targetFileId);
        const body = buildMultipartJsonBody(metadata, payload);
        const response = await client.request({
            path: targetFileId
                ? `/upload/drive/v3/files/${targetFileId}?uploadType=multipart`
                : '/upload/drive/v3/files?uploadType=multipart',
            method: targetFileId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}` },
            body,
        });
        ensureDriveRequestOk(response, 'Drive JSON upload');
        return { fileId: targetFileId ?? getUploadedDriveFileId(response) };
    }

    async uploadBlob(name: string, blob: Blob, mimeType: string): Promise<DriveJsonWrite | null> {
        if (!this.isInitialized || !this.folderId) return null;
        const accessToken = this.getAccessToken();
        if (!accessToken) return null;
        const metadata = buildDriveFileMetadata(name, mimeType, this.folderId, null);
        const body = buildMultipartBlobBody(metadata, blob, mimeType);
        const resp = await fetch(
            `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
                },
                body,
            },
        );
        if (!resp.ok) return null;
        const result = await resp.json() as { id?: string };
        return { fileId: result.id ?? null };
    }

    get initialized(): boolean {
        return this.isInitialized;
    }

    get currentFolderId(): string | null {
        return this.folderId;
    }

    private getClient(): GapiClient | null {
        return ((window as WindowWithGapi).gapi?.client) ?? null;
    }

    private getAccessToken(): string | null {
        return localStorage.getItem('google_access_token');
    }

    private async createFolder(client: GapiClient): Promise<string> {
        const createResponse = await client.request({
            path: '/drive/v3/files',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: this.folderName,
                mimeType: 'application/vnd.google-apps.folder',
            }),
        });
        ensureDriveRequestOk(createResponse, 'Drive folder create');
        const createdId = getUploadedDriveFileId(createResponse);
        if (!createdId) throw new Error('Failed to create Drive folder: no ID returned');
        return createdId;
    }
}
