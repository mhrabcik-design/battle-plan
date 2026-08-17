import { AuthUnavailableError, googleService } from './googleService.ts';
import { isAuthUnavailable } from '../types.ts';
import {
    DRIVE_PROTOCOL_PROPERTIES,
    type DriveProtocolApi,
    type DriveProtocolChangePage,
    type DriveProtocolFileMetadata,
    type DriveProtocolFilePage,
    type DriveWorkspaceBinding,
} from './agentProtocol/driveTransport.ts';

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
    result?: unknown;
    headers?: Record<string, string>;
    status?: number;
    statusText?: string;
}

interface GapiDriveClient {
    files: {
        list: (args: {
            spaces: string;
            q: string;
            fields: string;
            pageSize: number;
            pageToken?: string;
        }) => Promise<{ result: { files?: DriveFileMeta[]; nextPageToken?: string } }>;
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
    etag?: string;
}

export interface DriveJsonWrite {
    fileId: string | null;
    etag?: string;
}

export type DriveStoreStatusCode =
    | 'ready'
    | 'folder-created'
    | 'drive-client-unavailable'
    | 'auth-unavailable'
    | 'folder-missing'
    | 'init-error';

export interface DriveStoreStatus {
    code: DriveStoreStatusCode;
    message: string;
}

export type DriveJsonReadResult<T> =
    | { kind: 'loaded'; fileId: string; data: T; etag?: string }
    | { kind: 'missing-file' }
    | { kind: 'store-unavailable'; status: DriveStoreStatus }
    | { kind: 'error'; message: string };

export type DriveJsonReadManyResult<T> =
    | { kind: 'loaded'; files: DriveJsonRead<T>[] }
    | { kind: 'missing-file' }
    | { kind: 'store-unavailable'; status: DriveStoreStatus }
    | { kind: 'error'; message: string };

export function buildDriveFileMetadata(name: string, mimeType: string, folderId: string, fileId: string | null): DriveFileMetadata {
    const metadata: DriveFileMetadata = { name, mimeType };
    if (!fileId) {
        metadata.parents = [folderId];
    }
    return metadata;
}

export function getUploadedDriveFileId(response: DriveUploadResponse): string | null {
    if (response.result && typeof response.result === 'object' && 'id' in response.result && typeof response.result.id === 'string') {
        return response.result.id;
    }
    if (!response.body) return null;
    try {
        const parsed = JSON.parse(response.body) as { id?: string };
        return parsed.id ?? null;
    } catch {
        return null;
    }
}

function getDriveResponseEtag(response: DriveUploadResponse): string | undefined {
    const headers = response.headers;
    if (!headers) return undefined;
    const key = Object.keys(headers).find((header) => header.toLowerCase() === 'etag');
    return key ? headers[key] : undefined;
}

function getStrongDriveResponseEtag(response: DriveUploadResponse): string | undefined {
    const etag = getDriveResponseEtag(response);
    if (!etag || !/^"[\x21\x23-\x7E\x80-\xFF]*"$/.test(etag)) return undefined;
    return etag;
}

function getDriveRequestErrorMessage(error: unknown, action: string): string {
    if (error instanceof Error) return error.message;
    if (!error || typeof error !== 'object') return String(error);

    const response = error as {
        status?: unknown;
        statusText?: unknown;
        result?: { error?: { message?: unknown } };
    };
    if (typeof response.status !== 'number') return String(error);

    const statusText = typeof response.statusText === 'string' ? response.statusText : '';
    const apiMessage = typeof response.result?.error?.message === 'string'
        ? response.result.error.message
        : '';
    const detail = [statusText, apiMessage].filter(Boolean).join(' - ');
    return `${action} failed: ${response.status}${detail ? ` ${detail}` : ''}`;
}

function escapeDriveQueryValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class DriveRequestError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'DriveRequestError';
        this.status = status;
    }
}

function ensureDriveRequestOk(response: { status?: number; statusText?: string }, action: string): void {
    const { status } = response;
    if (status !== undefined && (status < 200 || status >= 300)) {
        throw new DriveRequestError(status, `${action} failed: ${status} ${response.statusText ?? ''}`.trim());
    }
}

function responseObject<T>(response: DriveUploadResponse, action: string): T {
    ensureDriveRequestOk(response, action);
    if (response.result && typeof response.result === 'object') return response.result as T;
    if (response.body) {
        try {
            return JSON.parse(response.body) as T;
        } catch (error) {
            throw new Error(`${action} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`${action} returned no JSON body`);
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

export function buildMultipartRawJsonBody(metadata: DriveFileMetadata, canonicalJson: string, boundary = MULTIPART_BOUNDARY): string {
    return '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        canonicalJson + '\r\n' +
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

function normalizeProtocolMetadata(input: Partial<DriveProtocolFileMetadata> & { id?: string }): DriveProtocolFileMetadata {
    if (!input.id) throw new Error('Drive metadata response is missing id');
    return {
        id: input.id,
        name: input.name ?? '',
        mimeType: input.mimeType ?? '',
        parents: input.parents ?? [],
        trashed: input.trashed ?? false,
        owners: input.owners ?? [],
        driveId: input.driveId ?? null,
        properties: input.properties ?? {},
        size: input.size ?? null,
    };
}

const PROTOCOL_FILE_FIELDS = 'id,name,mimeType,parents,trashed,owners(permissionId),driveId,properties,size';

/**
 * Browser/GAPI implementation of the source-independent immutable transport
 * boundary. Constructing this adapter does not start polling or command work.
 */
export class GapiDriveProtocolApi implements DriveProtocolApi {
    private readonly sharedDriveId: string | null;

    constructor(binding: DriveWorkspaceBinding) {
        this.sharedDriveId = binding.authority.kind === 'shared_drive' ? binding.authority.driveId : null;
    }

    async getFile(fileId: string): Promise<DriveProtocolFileMetadata> {
        const response = await this.client().request({
            path: `/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(PROTOCOL_FILE_FIELDS)}`,
            method: 'GET',
            headers: {},
            body: '',
        });
        return normalizeProtocolMetadata(responseObject(response, 'Drive protocol metadata read'));
    }

    async listFoldersByName(input: {
        name: string;
        expectedParentId: string;
        pageToken: string | null;
    }): Promise<DriveProtocolFilePage> {
        const query = `name='${escapeDriveQueryValue(input.name)}' and mimeType='application/vnd.google-apps.folder' and '${escapeDriveQueryValue(input.expectedParentId)}' in parents and trashed=false`;
        return this.listFiles(query, input.pageToken);
    }

    async listMessageFiles(input: {
        folderId: string;
        workspaceId: string;
        pageToken: string | null;
    }): Promise<DriveProtocolFilePage> {
        const query = [
            `'${escapeDriveQueryValue(input.folderId)}' in parents`,
            'trashed=false',
            `properties has { key='${DRIVE_PROTOCOL_PROPERTIES.protocolMajor}' and value='2' }`,
            `properties has { key='${DRIVE_PROTOCOL_PROPERTIES.workspaceId}' and value='${escapeDriveQueryValue(input.workspaceId)}' }`,
        ].join(' and ');
        return this.listFiles(query, input.pageToken);
    }

    async generateFileId(): Promise<string> {
        const response = await this.client().request({
            path: '/drive/v3/files/generateIds?count=1&space=drive&type=files',
            method: 'GET',
            headers: {},
            body: '',
        });
        const result = responseObject<{ ids?: string[] }>(response, 'Drive protocol file ID generation');
        if (!result.ids?.[0]) throw new Error('Drive protocol file ID generation returned no ID');
        return result.ids[0];
    }

    async createImmutableFile(input: {
        fileId: string;
        metadata: DriveProtocolFileMetadata;
        body: string;
    }): Promise<void> {
        const metadata = {
            id: input.fileId,
            name: input.metadata.name,
            mimeType: input.metadata.mimeType,
            parents: input.metadata.parents,
            properties: input.metadata.properties,
        };
        const response = await this.client().request({
            path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}` },
            body: buildMultipartRawJsonBody(metadata, input.body),
        });
        ensureDriveRequestOk(response, 'Immutable Drive protocol create');
        const createdId = getUploadedDriveFileId(response);
        if (createdId !== input.fileId) {
            throw new Error(`Immutable Drive protocol create returned unexpected file ID ${createdId ?? '<missing>'}`);
        }
    }

    async downloadFile(fileId: string): Promise<string> {
        const response = await this.client().request({
            path: `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
            method: 'GET',
            headers: {},
            body: '',
        });
        ensureDriveRequestOk(response, 'Drive protocol media read');
        if (typeof response.body !== 'string') throw new Error('Drive protocol media read returned no bytes');
        return response.body;
    }

    async getStartPageToken(): Promise<string> {
        const sharedDrive = this.sharedDriveId ? `&driveId=${encodeURIComponent(this.sharedDriveId)}` : '';
        const response = await this.client().request({
            path: `/drive/v3/changes/startPageToken?supportsAllDrives=true${sharedDrive}`,
            method: 'GET',
            headers: {},
            body: '',
        });
        const result = responseObject<{ startPageToken?: string }>(response, 'Drive start page token read');
        if (!result.startPageToken) throw new Error('Drive start page token response is missing startPageToken');
        return result.startPageToken;
    }

    async listChanges(pageToken: string): Promise<DriveProtocolChangePage> {
        const sharedDrive = this.sharedDriveId ? `&driveId=${encodeURIComponent(this.sharedDriveId)}` : '';
        const fields = `nextPageToken,newStartPageToken,changes(fileId,removed,file(${PROTOCOL_FILE_FIELDS}))`;
        const response = await this.client().request({
            path: `/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&pageSize=1000&spaces=drive&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=${encodeURIComponent(fields)}${sharedDrive}`,
            method: 'GET',
            headers: {},
            body: '',
        });
        const result = responseObject<{
            changes?: Array<{ fileId?: string; removed?: boolean; file?: Partial<DriveProtocolFileMetadata> }>;
            nextPageToken?: string;
            newStartPageToken?: string;
        }>(response, 'Drive change-page read');
        return {
            changes: (result.changes ?? []).map((change) => {
                if (!change.fileId) throw new Error('Drive change is missing fileId');
                return {
                    fileId: change.fileId,
                    removed: change.removed ?? false,
                    file: change.file ? normalizeProtocolMetadata(change.file) : null,
                };
            }),
            nextPageToken: result.nextPageToken ?? null,
            newStartPageToken: result.newStartPageToken ?? null,
        };
    }

    private async listFiles(query: string, pageToken: string | null): Promise<DriveProtocolFilePage> {
        const sharedDrive = this.sharedDriveId
            ? `&corpora=drive&driveId=${encodeURIComponent(this.sharedDriveId)}`
            : '&corpora=user';
        const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const fields = `nextPageToken,incompleteSearch,files(${PROTOCOL_FILE_FIELDS})`;
        const response = await this.client().request({
            path: `/drive/v3/files?q=${encodeURIComponent(query)}&spaces=drive&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=${encodeURIComponent(fields)}${sharedDrive}${token}`,
            method: 'GET',
            headers: {},
            body: '',
        });
        const result = responseObject<{
            files?: Array<Partial<DriveProtocolFileMetadata>>;
            nextPageToken?: string;
            incompleteSearch?: boolean;
        }>(response, 'Drive protocol list');
        return {
            files: (result.files ?? []).map(normalizeProtocolMetadata),
            nextPageToken: result.nextPageToken ?? null,
            incompleteSearch: result.incompleteSearch ?? false,
        };
    }

    private client(): GapiClient {
        const client = ((window as WindowWithGapi).gapi?.client) ?? null;
        if (!client) throw new Error('GAPI client is not available');
        return client;
    }
}

export class DriveJsonStore {
    private folderId: string | null = null;
    private isInitialized = false;
    private lastStatusValue: DriveStoreStatus = { code: 'folder-missing', message: 'Drive store není inicializovaný' };
    private readonly folderName: string;
    private readonly folderCacheKey: string;

    constructor(folderName = DEFAULT_FOLDER_NAME, folderCacheKey = DEFAULT_FOLDER_CACHE_KEY) {
        this.folderName = folderName;
        this.folderCacheKey = folderCacheKey;
    }

    async init(options: { createFolder?: boolean } = {}): Promise<boolean> {
        const status = await this.initWithStatus(options);
        return status.code === 'ready' || status.code === 'folder-created';
    }

    async initWithStatus(options: { createFolder?: boolean } = {}): Promise<DriveStoreStatus> {
        if (this.isInitialized) {
            this.lastStatusValue = { code: 'ready', message: 'Drive store je inicializovaný' };
            return this.lastStatusValue;
        }

        const client = this.getClient();
        if (!client?.drive) {
            console.warn('DriveJsonStore: GAPI Drive client not available');
            this.lastStatusValue = { code: 'drive-client-unavailable', message: 'Google Drive klient není dostupný' };
            return this.lastStatusValue;
        }

        try {
            await this.getAccessToken();
        } catch (e) {
            if (e instanceof AuthUnavailableError) {
                console.warn('DriveJsonStore: Not signed in');
                this.lastStatusValue = { code: 'auth-unavailable', message: e.message };
                return this.lastStatusValue;
            }
            throw e;
        }

        const cached = localStorage.getItem(this.folderCacheKey);
        if (cached) {
            this.folderId = cached;
            this.isInitialized = true;
            this.lastStatusValue = { code: 'ready', message: 'Drive složka načtena z cache' };
            return this.lastStatusValue;
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
                this.lastStatusValue = { code: 'ready', message: 'Drive složka nalezena' };
                return this.lastStatusValue;
            }
            if (options.createFolder) {
                this.folderId = await this.createFolder(client);
                localStorage.setItem(this.folderCacheKey, this.folderId);
                this.isInitialized = true;
                this.lastStatusValue = { code: 'folder-created', message: 'Drive složka vytvořena' };
                return this.lastStatusValue;
            }
            console.warn(`DriveJsonStore: Folder /${this.folderName}/ not found`);
            this.lastStatusValue = { code: 'folder-missing', message: `Drive složka /${this.folderName}/ nebyla nalezena` };
            return this.lastStatusValue;
        } catch (e) {
            console.error('DriveJsonStore: Failed to initialize folder', e);
            this.lastStatusValue = { code: 'init-error', message: e instanceof Error ? e.message : String(e) };
            return this.lastStatusValue;
        }
    }

    async findFileIds(name: string): Promise<string[]> {
        if (!this.isInitialized || !this.folderId) return [];
        const client = this.getClient();
        if (!client?.drive) return [];
        const files: DriveFileMeta[] = [];
        const seenPageTokens = new Set<string>();
        let pageToken: string | undefined;
        do {
            const listR = await client.drive.files.list({
                q: `name='${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(this.folderId)}' in parents and trashed=false`,
                spaces: 'drive',
                fields: 'files(id, name), nextPageToken',
                pageSize: 1000,
                ...(pageToken ? { pageToken } : {}),
            });
            files.push(...(listR.result.files ?? []));
            pageToken = listR.result.nextPageToken;
            if (pageToken && seenPageTokens.has(pageToken)) {
                throw new Error('Drive file listing repeated a page token');
            }
            if (pageToken) seenPageTokens.add(pageToken);
        } while (pageToken);
        return files
            .map((file) => file.id)
            .filter(Boolean)
            .sort();
    }

    async findFileId(name: string): Promise<string | null> {
        return (await this.findFileIds(name))[0] ?? null;
    }

    async readJsonFile<T>(name: string): Promise<DriveJsonRead<T> | null> {
        const result = await this.readJsonFileWithStatus<T>(name);
        if (result.kind !== 'loaded') return null;
        return { fileId: result.fileId, data: result.data, ...(result.etag ? { etag: result.etag } : {}) };
    }

    async readJsonFileWithStatus<T>(name: string): Promise<DriveJsonReadResult<T>> {
        if (!this.isInitialized || !this.folderId) {
            return { kind: 'store-unavailable', status: this.lastStatusValue };
        }
        const fileId = await this.findFileId(name);
        if (!fileId) return { kind: 'missing-file' };

        return this.readJsonFileByIdWithStatus<T>(fileId);
    }

    async readJsonFilesWithStatus<T>(name: string): Promise<DriveJsonReadManyResult<T>> {
        if (!this.isInitialized || !this.folderId) {
            return { kind: 'store-unavailable', status: this.lastStatusValue };
        }
        const fileIds = await this.findFileIds(name);
        if (fileIds.length === 0) return { kind: 'missing-file' };
        const results = await Promise.all(fileIds.map((fileId) => this.readJsonFileByIdWithStatus<T>(fileId)));
        const failed = results.find((result) => result.kind !== 'loaded');
        if (failed) return failed;
        return {
            kind: 'loaded',
            files: results.map((result) => {
                if (result.kind !== 'loaded') throw new Error('unreachable Drive JSON read state');
                return result;
            }),
        };
    }

    async readJsonFileByIdWithStatus<T>(fileId: string): Promise<DriveJsonReadResult<T>> {
        if (!this.isInitialized || !this.folderId) {
            return { kind: 'store-unavailable', status: this.lastStatusValue };
        }
        await this.getAccessToken();
        const client = this.getClient();
        if (!client) return { kind: 'error', message: 'GAPI client není dostupný' };

        try {
            const response = await client.request({
                path: `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
                method: 'GET',
                headers: {},
                body: '',
            });
            const data = responseObject<T>(response, 'Drive JSON media read');
            const etag = getStrongDriveResponseEtag(response);
            return { kind: 'loaded', fileId, data, ...(etag ? { etag } : {}) };
        } catch (error) {
            return { kind: 'error', message: getDriveRequestErrorMessage(error, 'Drive JSON media read') };
        }
    }

    async trashFile(fileId: string): Promise<void> {
        if (!this.isInitialized || !this.folderId) throw new Error('Drive store není inicializovaný');
        const client = this.getClient();
        if (!client) throw new Error('GAPI client není dostupný');
        const response = await client.request({
            path: `/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
            method: 'PATCH',
            headers: { 'Content-Type': JSON_MIME_TYPE },
            body: JSON.stringify({ trashed: true }),
        });
        ensureDriveRequestOk(response, 'Drive JSON duplicate cleanup');
    }

    async writeJsonFile(
        name: string,
        payload: unknown,
        fileId: string | null = null,
        options: { ifMatch?: string; createOnly?: boolean } = {},
    ): Promise<DriveJsonWrite | null> {
        if (!this.isInitialized || !this.folderId) return null;
        const client = this.getClient();
        if (!client) return null;
        const targetFileId = options.createOnly ? null : fileId ?? await this.findFileId(name);
        const metadata = buildDriveFileMetadata(name, JSON_MIME_TYPE, this.folderId, targetFileId);
        const body = buildMultipartJsonBody(metadata, payload);
        const response = await client.request({
            path: targetFileId
                ? `/upload/drive/v3/files/${targetFileId}?uploadType=multipart`
                : '/upload/drive/v3/files?uploadType=multipart',
            method: targetFileId ? 'PATCH' : 'POST',
            headers: {
                'Content-Type': `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
                ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
            },
            body,
        });
        ensureDriveRequestOk(response, 'Drive JSON upload');
        const etag = getDriveResponseEtag(response);
        return {
            fileId: targetFileId ?? getUploadedDriveFileId(response),
            ...(etag ? { etag } : {}),
        };
    }

    async uploadBlob(name: string, blob: Blob, mimeType: string): Promise<DriveJsonWrite | null> {
        if (!this.isInitialized || !this.folderId) return null;
        const accessToken = await this.getAccessToken();
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
        if (!resp.ok) {
            console.error(`DriveJsonStore: blob upload failed: ${resp.status} ${resp.statusText}`);
            return null;
        }
        const result = await resp.json() as { id?: string };
        return { fileId: result.id ?? null };
    }

    get initialized(): boolean {
        return this.isInitialized;
    }

    get currentFolderId(): string | null {
        return this.folderId;
    }

    get lastStatus(): DriveStoreStatus {
        return this.lastStatusValue;
    }

    private getClient(): GapiClient | null {
        return ((window as WindowWithGapi).gapi?.client) ?? null;
    }

    private async getAccessToken(): Promise<string> {
        const state = googleService.getAuthState();
        if (state === 'REFRESH_PENDING') {
            const refreshed = await googleService.runRefresh();
            if (!refreshed) {
                throw new AuthUnavailableError('Přihlášení vypršelo, obnovte prosím autorizaci.');
            }
        } else if (isAuthUnavailable(state)) {
            throw new AuthUnavailableError('Pro přístup na Drive je nutné přihlášení.');
        }
        const accessToken = googleService.getAuthStatus().accessToken;
        if (!accessToken) {
            throw new AuthUnavailableError('Přístupový token není dostupný.');
        }
        return accessToken;
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
