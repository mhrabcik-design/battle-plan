import { AuthUnavailableError, googleService } from './googleService.ts';
import { isAuthUnavailable } from '../types.ts';
import { captureGoogleAccountSession, type GoogleAccountSession } from './googleAccountSession.ts';
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
    version?: string;
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
    private readonly readCache = new Map<string, Map<string, { version: string; value: DriveJsonRead<unknown> }>>();
    private folderId: string | null = null;
    private isInitialized = false;
    private session: GoogleAccountSession | null = null;
    private initInFlight: { session: GoogleAccountSession; promise: Promise<DriveStoreStatus> } | null = null;
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
        this.invalidateChangedSession();
        const client = this.getClient();
        if (!client?.drive) {
            console.warn('DriveJsonStore: GAPI Drive client not available');
            this.lastStatusValue = { code: 'drive-client-unavailable', message: 'Google Drive klient není dostupný' };
            return this.lastStatusValue;
        }

        const accountBeforeAuth = googleService.getAccountId();
        const generationBeforeAuth = googleService.getAuthGeneration();
        const refreshing = googleService.getAuthState() === 'REFRESH_PENDING';
        const authSession = captureGoogleAccountSession();
        try {
            await this.getAccessToken();
        } catch (e) {
            if (!authSession.isCurrent()) return this.changedSessionStatus();
            if (e instanceof AuthUnavailableError) {
                console.warn('DriveJsonStore: Not signed in');
                this.lastStatusValue = { code: 'auth-unavailable', message: e.message };
                return this.lastStatusValue;
            }
            throw e;
        }
        const generationAfterAuth = googleService.getAuthGeneration();
        // Initialization may normalize one silent refresh for the same account.
        // Other transitions, including A -> B -> A, belong to another operation.
        if (accountBeforeAuth !== googleService.getAccountId()
            || (generationBeforeAuth !== generationAfterAuth
                && (!refreshing || generationAfterAuth !== generationBeforeAuth + 1))) {
            return this.changedSessionStatus();
        }
        this.invalidateChangedSession();
        if (this.isInitialized) {
            this.lastStatusValue = { code: 'ready', message: 'Drive store je inicializovaný' };
            return this.lastStatusValue;
        }
        if (this.initInFlight?.session.isCurrent()) {
            const status = await this.initInFlight.promise;
            return status.code === 'folder-missing' && options.createFolder ? this.initWithStatus(options) : status;
        }
        const session = captureGoogleAccountSession();
        this.session = session;
        const promise = this.initializeFolder(client, session, options).finally(() => {
            if (this.initInFlight?.promise === promise) this.initInFlight = null;
        });
        this.initInFlight = { session, promise };
        return promise;
    }

    private async initializeFolder(client: GapiClient, session: GoogleAccountSession, options: { createFolder?: boolean }): Promise<DriveStoreStatus> {
        if (!client.drive) return { code: 'drive-client-unavailable', message: 'Google Drive klient není dostupný' };
        const accountId = googleService.getAccountId();
        if (!accountId) return this.changedSessionStatus();
        // A legacy unscoped key has no verified owner and must be rediscovered.
        const cacheKey = `${this.folderCacheKey}:${encodeURIComponent(accountId)}`;
        const cached = localStorage.getItem(cacheKey);
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
            session.assertCurrent();
            if (r.result.files?.[0]) {
                this.folderId = r.result.files[0].id;
                localStorage.setItem(cacheKey, this.folderId);
                this.isInitialized = true;
                this.lastStatusValue = { code: 'ready', message: 'Drive složka nalezena' };
                return this.lastStatusValue;
            }
            if (options.createFolder) {
                const folderId = await this.createFolder(client);
                session.assertCurrent();
                this.folderId = folderId;
                localStorage.setItem(cacheKey, this.folderId);
                this.isInitialized = true;
                this.lastStatusValue = { code: 'folder-created', message: 'Drive složka vytvořena' };
                return this.lastStatusValue;
            }
            console.warn(`DriveJsonStore: Folder /${this.folderName}/ not found`);
            this.lastStatusValue = { code: 'folder-missing', message: `Drive složka /${this.folderName}/ nebyla nalezena` };
            return this.lastStatusValue;
        } catch (e) {
            if (!session.isCurrent()) return this.changedSessionStatus();
            console.error('DriveJsonStore: Failed to initialize folder', e);
            this.lastStatusValue = { code: 'init-error', message: e instanceof Error ? e.message : String(e) };
            return this.lastStatusValue;
        }
    }

    private async findFiles(name: string, context = this.operationContext()): Promise<DriveFileMeta[]> {
        if (!context) return [];
        await this.getAccessToken();
        context.session.assertCurrent();
        const client = this.getClient();
        if (!client?.drive) return [];
        const files: DriveFileMeta[] = [];
        const seenPageTokens = new Set<string>();
        let pageToken: string | undefined;
        do {
            const listR = await client.drive.files.list({
                q: `name='${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(context.folderId)}' in parents and trashed=false`,
                spaces: 'drive',
                fields: 'files(id, name, version), nextPageToken',
                pageSize: 1000,
                ...(pageToken ? { pageToken } : {}),
            });
            context.session.assertCurrent();
            files.push(...(listR.result.files ?? []));
            pageToken = listR.result.nextPageToken;
            if (pageToken && seenPageTokens.has(pageToken)) {
                throw new Error('Drive file listing repeated a page token');
            }
            if (pageToken) seenPageTokens.add(pageToken);
        } while (pageToken);
        return files.filter((file) => file.id).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    }

    async findFileIds(name: string): Promise<string[]> {
        return (await this.findFiles(name)).map((file) => file.id);
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
        const context = this.operationContext();
        if (!context) {
            return { kind: 'store-unavailable', status: this.lastStatusValue };
        }
        const fileId = (await this.findFiles(name, context))[0]?.id;
        context.session.assertCurrent();
        if (!fileId) return { kind: 'missing-file' };

        return this.readJsonById<T>(fileId, context);
    }

    async readJsonFilesWithStatus<T>(name: string, options: { cacheUnchanged?: boolean } = {}): Promise<DriveJsonReadManyResult<T>> {
        const context = this.operationContext();
        if (!context) {
            return { kind: 'store-unavailable', status: this.lastStatusValue };
        }
        // Opt-in for registry snapshots only. Mutable writers still read fresh content and ETags.
        const files = await this.findFiles(name, context);
        context.session.assertCurrent();
        const cache = this.readCache.get(name) ?? new Map<string, { version: string; value: DriveJsonRead<unknown> }>();
        if (options.cacheUnchanged) {
            const ids = new Set(files.map((file) => file.id));
            for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
            this.readCache.set(name, cache);
        }
        if (files.length === 0) return { kind: 'missing-file' };
        const results = await Promise.all(files.map(async (file): Promise<DriveJsonReadResult<T>> => {
            const cached = options.cacheUnchanged ? cache.get(file.id) : undefined;
            if (file.version && cached?.version === file.version) {
                return { kind: 'loaded', ...structuredClone(cached.value) as DriveJsonRead<T> };
            }
            const result = await this.readJsonById<T>(file.id, context);
            context.session.assertCurrent();
            if (options.cacheUnchanged && result.kind === 'loaded' && file.version) {
                cache.set(file.id, { version: file.version, value: structuredClone(result) });
            } else if (options.cacheUnchanged) cache.delete(file.id);
            return result;
        }));
        context.session.assertCurrent();
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
        const context = this.operationContext();
        if (!context) {
            return { kind: 'store-unavailable', status: this.lastStatusValue };
        }
        return this.readJsonById<T>(fileId, context);
    }

    private async readJsonById<T>(fileId: string, context: { folderId: string; session: GoogleAccountSession }): Promise<DriveJsonReadResult<T>> {
        await this.getAccessToken();
        context.session.assertCurrent();
        const client = this.getClient();
        if (!client) return { kind: 'error', message: 'GAPI client není dostupný' };

        try {
            const response = await client.request({
                path: `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
                method: 'GET',
                headers: {},
                body: '',
            });
            context.session.assertCurrent();
            const data = responseObject<T>(response, 'Drive JSON media read');
            const etag = getStrongDriveResponseEtag(response);
            return { kind: 'loaded', fileId, data, ...(etag ? { etag } : {}) };
        } catch (error) {
            return { kind: 'error', message: getDriveRequestErrorMessage(error, 'Drive JSON media read') };
        }
    }

    async trashFile(fileId: string): Promise<void> {
        const context = this.operationContext();
        if (!context) throw new Error('Drive store není inicializovaný');
        await this.getAccessToken();
        context.session.assertCurrent();
        const client = this.getClient();
        if (!client) throw new Error('GAPI client není dostupný');
        const response = await client.request({
            path: `/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
            method: 'PATCH',
            headers: { 'Content-Type': JSON_MIME_TYPE },
            body: JSON.stringify({ trashed: true }),
        });
        context.session.assertCurrent();
        ensureDriveRequestOk(response, 'Drive JSON duplicate cleanup');
    }

    async writeJsonFile(
        name: string,
        payload: unknown,
        fileId: string | null = null,
        options: { ifMatch?: string; createOnly?: boolean } = {},
    ): Promise<DriveJsonWrite | null> {
        const context = this.operationContext();
        if (!context) return null;
        await this.getAccessToken();
        context.session.assertCurrent();
        const client = this.getClient();
        if (!client) return null;
        const targetFileId = options.createOnly ? null : fileId ?? (await this.findFiles(name, context))[0]?.id ?? null;
        context.session.assertCurrent();
        const metadata = buildDriveFileMetadata(name, JSON_MIME_TYPE, context.folderId, targetFileId);
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
        context.session.assertCurrent();
        ensureDriveRequestOk(response, 'Drive JSON upload');
        const etag = getDriveResponseEtag(response);
        return {
            fileId: targetFileId ?? getUploadedDriveFileId(response),
            ...(etag ? { etag } : {}),
        };
    }

    async uploadBlob(name: string, blob: Blob, mimeType: string): Promise<DriveJsonWrite | null> {
        const context = this.operationContext();
        if (!context) return null;
        const accessToken = await this.getAccessToken();
        context.session.assertCurrent();
        const metadata = buildDriveFileMetadata(name, mimeType, context.folderId, null);
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
        context.session.assertCurrent();
        if (!resp.ok) {
            console.error(`DriveJsonStore: blob upload failed: ${resp.status} ${resp.statusText}`);
            return null;
        }
        const result = await resp.json() as { id?: string };
        context.session.assertCurrent();
        return { fileId: result.id ?? null };
    }

    get initialized(): boolean {
        this.invalidateChangedSession();
        return this.isInitialized;
    }

    get currentFolderId(): string | null {
        this.invalidateChangedSession();
        return this.folderId;
    }

    get lastStatus(): DriveStoreStatus {
        this.invalidateChangedSession();
        return this.lastStatusValue;
    }

    private changedSessionStatus(): DriveStoreStatus {
        return { code: 'auth-unavailable', message: 'Přihlášení Google se během synchronizace změnilo.' };
    }

    private invalidateChangedSession() {
        if (!this.session || this.session.isCurrent()) return;
        this.session = null;
        this.initInFlight = null;
        this.isInitialized = false;
        this.folderId = null;
        this.readCache.clear();
        this.lastStatusValue = this.changedSessionStatus();
    }

    private operationContext() {
        if (!this.initialized || !this.folderId || !this.session) return null;
        return { folderId: this.folderId, session: this.session };
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
