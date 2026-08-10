import {
    PROTOCOL_MAJOR,
    type ProtocolErrorCode,
    type ProtocolValidationResult,
    type ProtocolWireMessage,
} from './contracts.ts';
import {
    canonicalizeProtocolJson,
    validateProtocolWireMessage,
    verifyProtocolWireMessage,
    type VerifyProtocolOptions,
} from './validation.ts';

export const DRIVE_PROTOCOL_JSON_MIME_TYPE = 'application/json' as const;
export const DRIVE_PROTOCOL_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder' as const;

export const DRIVE_PROTOCOL_PROPERTIES = Object.freeze({
    transportProfile: 'bpv2_transport_profile',
    protocolMajor: 'bpv2_protocol_major',
    messageType: 'bpv2_message_type',
    messageId: 'bpv2_message_id',
    workspaceId: 'bpv2_workspace_id',
    producerId: 'bpv2_producer_id',
    keyId: 'bpv2_key_id',
    pairingEpoch: 'bpv2_pairing_epoch',
    contentSha256: 'bpv2_content_sha256',
    bodySha256: 'bpv2_body_sha256',
} as const);

export type DriveTransportErrorCode =
    | 'authorization_failed'
    | 'rate_limited'
    | 'transport_retryable'
    | 'transport_error'
    | 'workspace_missing'
    | 'workspace_ambiguous'
    | 'workspace_parent_mismatch'
    | 'workspace_authority_mismatch'
    | 'stale_binding_cache'
    | 'incomplete_search'
    | 'missing_file'
    | 'malformed_message'
    | 'unsupported_message'
    | 'verification_failed'
    | 'metadata_mismatch'
    | 'immutable_file_conflict';

export class DriveTransportError extends Error {
    readonly code: DriveTransportErrorCode;
    readonly cause?: unknown;

    constructor(
        code: DriveTransportErrorCode,
        message: string,
        cause?: unknown,
    ) {
        super(message);
        this.name = 'DriveTransportError';
        this.code = code;
        this.cause = cause;
    }
}

export type DriveWorkspaceAuthority =
    | { kind: 'shared_drive'; driveId: string }
    | { kind: 'owner'; ownerPermissionId: string };

export interface DriveWorkspaceBinding {
    /** Stable account discriminator, normally the authenticated Google account email. */
    accountId: string;
    folderId: string;
    folderName: string;
    expectedParentId: string;
    authority: DriveWorkspaceAuthority;
    workspaceId: string;
}

export interface DriveProtocolFileMetadata {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    trashed: boolean;
    owners: Array<{ permissionId: string }>;
    driveId: string | null;
    properties: Record<string, string>;
    /** Decimal byte count returned by Drive. Null is valid for folders. */
    size: string | null;
}

export interface DriveProtocolFilePage {
    files: DriveProtocolFileMetadata[];
    nextPageToken: string | null;
    incompleteSearch: boolean;
}

export interface DriveProtocolChange {
    fileId: string;
    removed: boolean;
    file: DriveProtocolFileMetadata | null;
}

export interface DriveProtocolChangePage {
    changes: DriveProtocolChange[];
    nextPageToken: string | null;
    newStartPageToken: string | null;
}

/**
 * Source-independent Drive boundary. A Hermes adapter can implement this exact
 * interface with its own Google client without importing BattlePlan source.
 */
export interface DriveProtocolApi {
    getFile(fileId: string): Promise<DriveProtocolFileMetadata>;
    listFoldersByName(input: {
        name: string;
        expectedParentId: string;
        pageToken: string | null;
    }): Promise<DriveProtocolFilePage>;
    listMessageFiles(input: {
        folderId: string;
        workspaceId: string;
        pageToken: string | null;
    }): Promise<DriveProtocolFilePage>;
    generateFileId(): Promise<string>;
    createImmutableFile(input: {
        fileId: string;
        metadata: DriveProtocolFileMetadata;
        body: string;
    }): Promise<void>;
    downloadFile(fileId: string): Promise<string>;
    getStartPageToken(): Promise<string>;
    listChanges(pageToken: string): Promise<DriveProtocolChangePage>;
}

export interface DriveTransportCursorStore {
    load(): Promise<string | null>;
    save(value: string): Promise<void>;
}

export interface DriveWorkspaceBindingCache {
    load(): Promise<DriveWorkspaceBinding | null>;
    save(binding: DriveWorkspaceBinding): Promise<void>;
}

export interface DriveTransportStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

function isWorkspaceBinding(value: unknown): value is DriveWorkspaceBinding {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<DriveWorkspaceBinding>;
    if (![candidate.accountId, candidate.folderId, candidate.folderName, candidate.expectedParentId, candidate.workspaceId]
        .every((field) => typeof field === 'string' && field.length > 0)) return false;
    if (!candidate.authority || typeof candidate.authority !== 'object') return false;
    return candidate.authority.kind === 'shared_drive'
        ? typeof candidate.authority.driveId === 'string' && candidate.authority.driveId.length > 0
        : candidate.authority.kind === 'owner'
            && typeof candidate.authority.ownerPermissionId === 'string'
            && candidate.authority.ownerPermissionId.length > 0;
}

function transportStateKey(kind: 'cursor' | 'binding', binding: DriveWorkspaceBinding): string {
    return `bp_agent_v2_${kind}:${encodeURIComponent(binding.accountId)}:${binding.workspaceId}`;
}

export class LocalStorageDriveCursorStore implements DriveTransportCursorStore {
    private readonly storage: DriveTransportStorage;
    private readonly key: string;

    constructor(storage: DriveTransportStorage, binding: DriveWorkspaceBinding) {
        this.storage = storage;
        this.key = transportStateKey('cursor', binding);
    }

    async load(): Promise<string | null> {
        return this.storage.getItem(this.key);
    }

    async save(value: string): Promise<void> {
        this.storage.setItem(this.key, value);
    }
}

export class LocalStorageDriveBindingCache implements DriveWorkspaceBindingCache {
    private readonly storage: DriveTransportStorage;
    private readonly key: string;

    constructor(storage: DriveTransportStorage, binding: DriveWorkspaceBinding) {
        this.storage = storage;
        this.key = transportStateKey('binding', binding);
    }

    async load(): Promise<DriveWorkspaceBinding | null> {
        const raw = this.storage.getItem(this.key);
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (!isWorkspaceBinding(parsed)) throw new Error('binding shape is invalid');
            return parsed;
        } catch (error) {
            throw new DriveTransportError('stale_binding_cache', 'Cached Drive workspace binding is not valid JSON', error);
        }
    }

    async save(binding: DriveWorkspaceBinding): Promise<void> {
        this.storage.setItem(this.key, JSON.stringify(binding));
    }
}

export interface PreparedDriveProtocolMessage {
    fileId: string;
    body: string;
    bodySha256: `sha256:${string}`;
    contentSha256: `sha256:${string}`;
    metadata: DriveProtocolFileMetadata;
    preparedSha256: `sha256:${string}`;
}

export interface VerifiedDriveProtocolMessage {
    fileId: string;
    body: string;
    metadata: DriveProtocolFileMetadata;
    message: ProtocolWireMessage;
    contentSha256: `sha256:${string}`;
}

export type DriveVerificationOptionsResolver = (
    structurallyValidMessage: ProtocolWireMessage,
) => Promise<VerifyProtocolOptions | null> | VerifyProtocolOptions | null;

const FULL_U1_VERIFIER = Symbol('BattlePlan-Hermes/full-u1-verifier');

export interface FullU1DriveMessageVerifier {
    readonly verify: (rawCanonicalJson: string) => Promise<ProtocolValidationResult>;
    readonly [FULL_U1_VERIFIER]: true;
}

/** The only supported production verifier factory; it always executes full U1 verification. */
export function createFullU1DriveMessageVerifier(
    resolveOptions: DriveVerificationOptionsResolver,
): FullU1DriveMessageVerifier {
    return Object.freeze({
        [FULL_U1_VERIFIER]: true as const,
        verify: async (rawCanonicalJson: string): Promise<ProtocolValidationResult> => {
            const structural = validateProtocolWireMessage(rawCanonicalJson);
            if (!structural.ok) return structural;
            const options = await resolveOptions(structural.message);
            if (!options) {
                return {
                    ok: false,
                    error: { code: 'key_unknown', message: 'No trusted pairing record exists for this Drive message' },
                };
            }
            return verifyProtocolWireMessage(rawCanonicalJson, options);
        },
    });
}

export interface ImmutableDriveTransportOptions {
    api: DriveProtocolApi;
    binding: DriveWorkspaceBinding;
    cursorStore: DriveTransportCursorStore;
    bindingCache?: DriveWorkspaceBindingCache;
    /** Branded factory product that always performs complete U1 verification. */
    verifier: FullU1DriveMessageVerifier;
    /** Test seam only; production uses real bounded backoff delays. */
    sleep?: (delayMs: number) => Promise<void>;
}

function encoderBytes(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<`sha256:${string}`> {
    if (!globalThis.crypto?.subtle) {
        throw new DriveTransportError('verification_failed', 'SHA-256 WebCrypto support is required');
    }
    const source = encoderBytes(value);
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer);
    return `sha256:${toHex(new Uint8Array(digest))}`;
}

function sameAuthority(left: DriveWorkspaceAuthority, right: DriveWorkspaceAuthority): boolean {
    if (left.kind !== right.kind) return false;
    return left.kind === 'shared_drive'
        ? left.driveId === (right as Extract<DriveWorkspaceAuthority, { kind: 'shared_drive' }>).driveId
        : left.ownerPermissionId === (right as Extract<DriveWorkspaceAuthority, { kind: 'owner' }>).ownerPermissionId;
}

function sameBinding(left: DriveWorkspaceBinding, right: DriveWorkspaceBinding): boolean {
    return left.accountId === right.accountId
        && left.folderId === right.folderId
        && left.folderName === right.folderName
        && left.expectedParentId === right.expectedParentId
        && left.workspaceId === right.workspaceId
        && sameAuthority(left.authority, right.authority);
}

function httpStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const candidate = error as {
        status?: unknown;
        code?: unknown;
        result?: { error?: { code?: unknown } };
    };
    for (const value of [candidate.status, candidate.code, candidate.result?.error?.code]) {
        if (typeof value === 'number' && Number.isInteger(value)) return value;
    }
    return null;
}

function normalizeDriveError(error: unknown, action: string): DriveTransportError {
    if (error instanceof DriveTransportError) return error;
    const status = httpStatus(error);
    const suffix = error instanceof Error ? `: ${error.message}` : '';
    if (status === 401 || status === 403) {
        return new DriveTransportError('authorization_failed', `${action} was not authorized (${status})${suffix}`, error);
    }
    if (status === 404) {
        return new DriveTransportError('missing_file', `${action} could not find the expected Drive object${suffix}`, error);
    }
    if (status === 429) {
        return new DriveTransportError('rate_limited', `${action} was rate limited${suffix}`, error);
    }
    if (status !== null && status >= 500) {
        return new DriveTransportError('transport_retryable', `${action} failed transiently (${status})${suffix}`, error);
    }
    if (error instanceof TypeError) {
        return new DriveTransportError('transport_retryable', `${action} failed because the network request did not complete${suffix}`, error);
    }
    return new DriveTransportError('transport_error', `${action} failed${suffix}`, error);
}

function isRetryableTransportError(error: DriveTransportError): boolean {
    return error.code === 'rate_limited' || error.code === 'transport_retryable';
}

function assertSoleParent(metadata: DriveProtocolFileMetadata, expectedParentId: string, code: DriveTransportErrorCode): void {
    if (metadata.parents.length !== 1 || metadata.parents[0] !== expectedParentId) {
        throw new DriveTransportError(code, `Drive object ${metadata.id} does not have the sole expected parent ${expectedParentId}`);
    }
}

function assertWorkspaceAuthority(metadata: DriveProtocolFileMetadata, authority: DriveWorkspaceAuthority): void {
    if (authority.kind === 'shared_drive') {
        if (metadata.driveId !== authority.driveId) {
            throw new DriveTransportError('workspace_authority_mismatch', `Folder ${metadata.id} belongs to another shared drive`);
        }
        return;
    }
    if (metadata.driveId !== null || !metadata.owners.some((owner) => owner.permissionId === authority.ownerPermissionId)) {
        throw new DriveTransportError('workspace_authority_mismatch', `Folder ${metadata.id} has an unexpected owner authority`);
    }
}

function expectedProperties(
    message: ProtocolWireMessage,
    contentSha256: `sha256:${string}`,
    bodySha256: `sha256:${string}`,
): Record<string, string> {
    return {
        [DRIVE_PROTOCOL_PROPERTIES.transportProfile]: 'drive-immutable-v2',
        [DRIVE_PROTOCOL_PROPERTIES.protocolMajor]: String(PROTOCOL_MAJOR),
        [DRIVE_PROTOCOL_PROPERTIES.messageType]: message.signed.message_type,
        [DRIVE_PROTOCOL_PROPERTIES.messageId]: message.signed.message_id,
        [DRIVE_PROTOCOL_PROPERTIES.workspaceId]: message.signed.workspace_id,
        [DRIVE_PROTOCOL_PROPERTIES.producerId]: message.signed.producer_id,
        [DRIVE_PROTOCOL_PROPERTIES.keyId]: message.signed.signing_key_id,
        [DRIVE_PROTOCOL_PROPERTIES.pairingEpoch]: String(message.signed.pairing_epoch),
        [DRIVE_PROTOCOL_PROPERTIES.contentSha256]: contentSha256,
        [DRIVE_PROTOCOL_PROPERTIES.bodySha256]: bodySha256,
    };
}

function assertExpectedMetadata(
    actual: DriveProtocolFileMetadata,
    expected: DriveProtocolFileMetadata,
    code: DriveTransportErrorCode,
): void {
    if (actual.id !== expected.id
        || actual.name !== expected.name
        || actual.mimeType !== DRIVE_PROTOCOL_JSON_MIME_TYPE
        || actual.trashed
        || actual.size !== expected.size) {
        throw new DriveTransportError(code, `Drive metadata for ${expected.id} does not match the immutable message`);
    }
    assertSoleParent(actual, expected.parents[0], code);
    for (const [key, value] of Object.entries(expected.properties)) {
        if (actual.properties[key] !== value) {
            throw new DriveTransportError(code, `Drive property ${key} for ${expected.id} does not match the verified body`);
        }
    }
}

function classifyValidationFailure(error: { code: ProtocolErrorCode; message: string }): DriveTransportError {
    if (error.code === 'unsupported_major' || error.code === 'unknown_message_type' || error.code === 'unknown_action') {
        return new DriveTransportError('unsupported_message', `${error.code}: ${error.message}`);
    }
    if (['invalid_json', 'duplicate_json_key', 'non_canonical_json', 'payload_too_large', 'schema_invalid'].includes(error.code)) {
        return new DriveTransportError('malformed_message', `${error.code}: ${error.message}`);
    }
    return new DriveTransportError('verification_failed', `${error.code}: ${error.message}`);
}

const MAX_DRIVE_PAGES = 10_000;
const DRIVE_RETRY_DELAYS_MS = [500, 1_000] as const;
const PREPARED_RECORD_DOMAIN = 'BattlePlan-Hermes/drive-prepared/v2\0' as const;
type SynchronizationKind = 'scan' | 'cursor';

export class ImmutableDriveTransport {
    private readonly api: DriveProtocolApi;
    private readonly binding: DriveWorkspaceBinding;
    private readonly cursorStore: DriveTransportCursorStore;
    private readonly bindingCache?: DriveWorkspaceBindingCache;
    private readonly verifier: FullU1DriveMessageVerifier;
    private readonly sleep: (delayMs: number) => Promise<void>;
    private synchronizationInFlight: { kind: SynchronizationKind; promise: Promise<void> } | null = null;

    constructor(options: ImmutableDriveTransportOptions) {
        this.api = options.api;
        this.binding = structuredClone(options.binding);
        this.cursorStore = options.cursorStore;
        this.bindingCache = options.bindingCache;
        if (options.verifier?.[FULL_U1_VERIFIER] !== true) {
            throw new DriveTransportError('verification_failed', 'Immutable Drive transport requires the production full-U1 verifier factory');
        }
        this.verifier = options.verifier;
        this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    }

    async verifyWorkspace(): Promise<DriveProtocolFileMetadata> {
        if (this.bindingCache) {
            const cached = await this.bindingCache.load();
            if (cached && !sameBinding(cached, this.binding)) {
                throw new DriveTransportError('stale_binding_cache', 'Cached Drive binding belongs to another account, workspace, folder, parent, or authority');
            }
        }

        const candidates: DriveProtocolFileMetadata[] = [];
        let pageToken: string | null = null;
        for (let page = 0; page < MAX_DRIVE_PAGES; page += 1) {
            const result = await this.withRetry('Drive workspace folder lookup', () =>
                this.api.listFoldersByName({
                    name: this.binding.folderName,
                    expectedParentId: this.binding.expectedParentId,
                    pageToken,
                }),
            );
            if (result.incompleteSearch) {
                throw new DriveTransportError('incomplete_search', 'Drive returned incompleteSearch while resolving the protocol workspace');
            }
            candidates.push(...result.files);
            pageToken = result.nextPageToken;
            if (!pageToken) break;
            if (page === MAX_DRIVE_PAGES - 1) throw new DriveTransportError('transport_error', 'Drive folder pagination limit exceeded');
        }

        if (candidates.length === 0) {
            throw new DriveTransportError('workspace_missing', 'The explicitly paired Drive protocol folder is missing');
        }
        if (candidates.length !== 1 || candidates[0].id !== this.binding.folderId) {
            throw new DriveTransportError('workspace_ambiguous', 'Drive workspace folder name is ambiguous or does not match the pinned folder ID');
        }

        const folder = await this.withRetry(
            'Pinned Drive workspace metadata read',
            () => this.api.getFile(this.binding.folderId),
        );
        if (folder.name !== this.binding.folderName
            || folder.mimeType !== DRIVE_PROTOCOL_FOLDER_MIME_TYPE
            || folder.trashed) {
            throw new DriveTransportError('workspace_ambiguous', 'Pinned Drive workspace is missing, trashed, renamed, or not a folder');
        }
        assertSoleParent(folder, this.binding.expectedParentId, 'workspace_parent_mismatch');
        assertWorkspaceAuthority(folder, this.binding.authority);
        await this.bindingCache?.save(structuredClone(this.binding));
        return folder;
    }

    /** Reserve the generated Drive ID before an outbox attempts network upload. */
    async prepare(body: string): Promise<PreparedDriveProtocolMessage> {
        const validation = validateProtocolWireMessage(body);
        if (!validation.ok) throw classifyValidationFailure(validation.error);
        if (validation.message.signed.workspace_id !== this.binding.workspaceId) {
            throw new DriveTransportError('metadata_mismatch', 'Outbound message workspace does not match the paired Drive binding');
        }
        const fileId = await this.withRetry('Drive file ID generation', () => this.api.generateFileId());
        const bodySha256 = await sha256(body);
        const properties = expectedProperties(validation.message, validation.contentSha256, bodySha256);
        const prepared = {
            fileId,
            body,
            bodySha256,
            contentSha256: validation.contentSha256,
            metadata: {
                id: fileId,
                name: `${validation.message.signed.message_id}.json`,
                mimeType: DRIVE_PROTOCOL_JSON_MIME_TYPE,
                parents: [this.binding.folderId],
                trashed: false,
                owners: [],
                driveId: this.binding.authority.kind === 'shared_drive' ? this.binding.authority.driveId : null,
                properties,
                size: String(encoderBytes(body).byteLength),
            },
        };
        return { ...prepared, preparedSha256: await this.calculatePreparedRecordSha256(prepared) };
    }

    async publish(prepared: PreparedDriveProtocolMessage): Promise<{ kind: 'published'; fileId: string; replayed: boolean }> {
        const immutablePrepared = structuredClone(prepared);
        await this.assertPreparedRecord(immutablePrepared);
        await this.verifyWorkspace();
        for (let attempt = 0; attempt <= DRIVE_RETRY_DELAYS_MS.length; attempt += 1) {
            try {
                await this.api.createImmutableFile(immutablePrepared);
                return { kind: 'published', fileId: immutablePrepared.fileId, replayed: false };
            } catch (error) {
                if (httpStatus(error) === 409) {
                    await this.verifyPreparedExisting(immutablePrepared);
                    return { kind: 'published', fileId: immutablePrepared.fileId, replayed: true };
                }
                const normalized = normalizeDriveError(error, 'Immutable Drive message create');
                if (!isRetryableTransportError(normalized)) throw normalized;

                const existing = await this.findPreparedExisting(immutablePrepared);
                if (existing) return { kind: 'published', fileId: immutablePrepared.fileId, replayed: true };
                if (attempt === DRIVE_RETRY_DELAYS_MS.length) throw normalized;
                await this.sleep(DRIVE_RETRY_DELAYS_MS[attempt]);
            }
        }
        throw new DriveTransportError('transport_retryable', 'Immutable Drive message create exhausted its bounded retry budget');
    }

    async readVerified(fileId: string): Promise<VerifiedDriveProtocolMessage> {
        const metadata = await this.withRetry(
            `Drive protocol file ${fileId} metadata read`,
            () => this.api.getFile(fileId),
        );
        const body = await this.withRetry(
            `Drive protocol file ${fileId} media read`,
            () => this.api.downloadFile(fileId),
        );
        if (metadata.mimeType !== DRIVE_PROTOCOL_JSON_MIME_TYPE || metadata.trashed) {
            throw new DriveTransportError('metadata_mismatch', `Drive protocol file ${fileId} is trashed or has the wrong MIME type`);
        }
        assertSoleParent(metadata, this.binding.folderId, 'metadata_mismatch');
        if (metadata.size !== null && metadata.size !== String(encoderBytes(body).byteLength)) {
            throw new DriveTransportError('metadata_mismatch', `Drive protocol file ${fileId} size does not match downloaded bytes`);
        }

        const verified = await this.verifier.verify(body);
        if (!verified.ok) throw classifyValidationFailure(verified.error);
        if (verified.message.signed.workspace_id !== this.binding.workspaceId) {
            throw new DriveTransportError('metadata_mismatch', `Drive protocol file ${fileId} belongs to another workspace`);
        }
        const bodySha256 = await sha256(body);
        const expected: DriveProtocolFileMetadata = {
            id: fileId,
            name: `${verified.message.signed.message_id}.json`,
            mimeType: DRIVE_PROTOCOL_JSON_MIME_TYPE,
            parents: [this.binding.folderId],
            trashed: false,
            owners: metadata.owners,
            driveId: metadata.driveId,
            properties: expectedProperties(verified.message, verified.contentSha256, bodySha256),
            size: String(encoderBytes(body).byteLength),
        };
        assertExpectedMetadata(metadata, expected, 'metadata_mismatch');
        return {
            fileId,
            body,
            metadata,
            message: verified.message,
            contentSha256: verified.contentSha256,
        };
    }

    async scanAll(consume: (message: VerifiedDriveProtocolMessage) => Promise<void>): Promise<void> {
        return this.runSynchronization('scan', async () => {
            await this.verifyWorkspace();
            await this.scanAllInternal(consume, new Set());
        });
    }

    async bootstrap(consume: (message: VerifiedDriveProtocolMessage) => Promise<void>): Promise<void> {
        return this.runSynchronization('cursor', () => this.bootstrapOnce(consume));
    }

    async poll(consume: (message: VerifiedDriveProtocolMessage) => Promise<void>): Promise<void> {
        return this.runSynchronization('cursor', () => this.pollOnce(consume));
    }

    private async bootstrapOnce(consume: (message: VerifiedDriveProtocolMessage) => Promise<void>): Promise<void> {
        await this.verifyWorkspace();
        const startToken = await this.withRetry(
            'Drive start page token capture',
            () => this.api.getStartPageToken(),
        );
        const seen = new Set<string>();
        await this.scanAllInternal(consume, seen);
        const finalToken = await this.consumeChangePages(startToken, consume, seen, false);
        await this.cursorStore.save(finalToken);
    }

    private async pollOnce(consume: (message: VerifiedDriveProtocolMessage) => Promise<void>): Promise<void> {
        const cursor = await this.cursorStore.load();
        if (!cursor) {
            await this.bootstrapOnce(consume);
            return;
        }
        await this.verifyWorkspace();
        await this.consumeChangePages(cursor, consume, new Set(), true);
    }

    private runSynchronization(kind: SynchronizationKind, work: () => Promise<void>): Promise<void> {
        const current = this.synchronizationInFlight;
        if (current) {
            if (current.kind === kind) return current.promise;
            return current.promise.then(
                () => this.runSynchronization(kind, work),
                () => this.runSynchronization(kind, work),
            );
        }
        const pending = work().finally(() => {
            if (this.synchronizationInFlight?.promise === pending) this.synchronizationInFlight = null;
        });
        this.synchronizationInFlight = { kind, promise: pending };
        return pending;
    }

    private async scanAllInternal(
        consume: (message: VerifiedDriveProtocolMessage) => Promise<void>,
        seen: Set<string>,
    ): Promise<void> {
        let pageToken: string | null = null;
        for (let page = 0; page < MAX_DRIVE_PAGES; page += 1) {
            const result = await this.withRetry('Drive protocol folder scan', () =>
                this.api.listMessageFiles({
                    folderId: this.binding.folderId,
                    workspaceId: this.binding.workspaceId,
                    pageToken,
                }),
            );
            if (result.incompleteSearch) {
                throw new DriveTransportError('incomplete_search', 'Drive returned incompleteSearch during protocol message scan');
            }
            for (const listed of result.files) {
                if (seen.has(listed.id)) continue;
                const message = await this.readVerified(listed.id);
                await consume(message);
                seen.add(listed.id);
            }
            pageToken = result.nextPageToken;
            if (!pageToken) return;
        }
        throw new DriveTransportError('transport_error', 'Drive message pagination limit exceeded');
    }

    private async consumeChangePages(
        initialToken: string,
        consume: (message: VerifiedDriveProtocolMessage) => Promise<void>,
        seen: Set<string>,
        persistEachPage: boolean,
    ): Promise<string> {
        let pageToken = initialToken;
        for (let page = 0; page < MAX_DRIVE_PAGES; page += 1) {
            const result = await this.withRetry(
                'Drive protocol change-page read',
                () => this.api.listChanges(pageToken),
            );
            for (const change of result.changes) {
                if (change.removed || change.file?.trashed) {
                    if (change.file && this.isBoundProtocolIdentity(change.file)) {
                        throw new DriveTransportError('missing_file', `Immutable Drive protocol file ${change.fileId} was removed`);
                    }
                    continue;
                }
                if (seen.has(change.fileId)) continue;
                if (change.file && !this.isBoundProtocolFile(change.file)) continue;
                const message = await this.readVerified(change.fileId);
                await consume(message);
                seen.add(change.fileId);
            }
            if (result.nextPageToken) {
                if (persistEachPage) await this.cursorStore.save(result.nextPageToken);
                pageToken = result.nextPageToken;
                continue;
            }
            if (!result.newStartPageToken) {
                throw new DriveTransportError('transport_retryable', 'Drive change feed ended without a new start page token');
            }
            if (persistEachPage) await this.cursorStore.save(result.newStartPageToken);
            return result.newStartPageToken;
        }
        throw new DriveTransportError('transport_error', 'Drive change pagination limit exceeded');
    }

    private isBoundProtocolFile(metadata: DriveProtocolFileMetadata): boolean {
        return !metadata.trashed && this.isBoundProtocolIdentity(metadata);
    }

    private isBoundProtocolIdentity(metadata: DriveProtocolFileMetadata): boolean {
        return metadata.mimeType === DRIVE_PROTOCOL_JSON_MIME_TYPE
            && metadata.parents.length === 1
            && metadata.parents[0] === this.binding.folderId
            && metadata.properties[DRIVE_PROTOCOL_PROPERTIES.protocolMajor] === String(PROTOCOL_MAJOR)
            && metadata.properties[DRIVE_PROTOCOL_PROPERTIES.workspaceId] === this.binding.workspaceId;
    }

    private async assertPreparedRecord(prepared: PreparedDriveProtocolMessage): Promise<void> {
        const expectedPreparedSha256 = await this.calculatePreparedRecordSha256({
            fileId: prepared.fileId,
            body: prepared.body,
            bodySha256: prepared.bodySha256,
            contentSha256: prepared.contentSha256,
            metadata: prepared.metadata,
        });
        if (prepared.preparedSha256 !== expectedPreparedSha256) {
            throw new DriveTransportError('immutable_file_conflict', 'Persisted prepared Drive record does not match its preparation seal');
        }
        const validation = validateProtocolWireMessage(prepared.body);
        if (!validation.ok) throw classifyValidationFailure(validation.error);
        if (validation.message.signed.workspace_id !== this.binding.workspaceId) {
            throw new DriveTransportError('metadata_mismatch', 'Prepared message workspace does not match the paired Drive binding');
        }
        const bodySha256 = await sha256(prepared.body);
        if (prepared.bodySha256 !== bodySha256 || prepared.contentSha256 !== validation.contentSha256) {
            throw new DriveTransportError('immutable_file_conflict', 'Prepared message digests do not match its immutable bytes');
        }
        const expected: DriveProtocolFileMetadata = {
            id: prepared.fileId,
            name: `${validation.message.signed.message_id}.json`,
            mimeType: DRIVE_PROTOCOL_JSON_MIME_TYPE,
            parents: [this.binding.folderId],
            trashed: false,
            owners: prepared.metadata.owners,
            driveId: prepared.metadata.driveId,
            properties: expectedProperties(validation.message, validation.contentSha256, bodySha256),
            size: String(encoderBytes(prepared.body).byteLength),
        };
        assertExpectedMetadata(prepared.metadata, expected, 'immutable_file_conflict');
    }

    private async calculatePreparedRecordSha256(
        prepared: Omit<PreparedDriveProtocolMessage, 'preparedSha256'>,
    ): Promise<`sha256:${string}`> {
        return sha256(`${PREPARED_RECORD_DOMAIN}${canonicalizeProtocolJson(prepared)}`);
    }

    private async findPreparedExisting(prepared: PreparedDriveProtocolMessage): Promise<boolean> {
        try {
            await this.verifyPreparedExisting(prepared);
            return true;
        } catch (error) {
            if (error instanceof DriveTransportError && error.code === 'missing_file') return false;
            throw error;
        }
    }

    private async verifyPreparedExisting(prepared: PreparedDriveProtocolMessage): Promise<void> {
        const existingMetadata = await this.withRetry(
            'Ambiguous Drive create metadata verification',
            () => this.api.getFile(prepared.fileId),
        );
        assertExpectedMetadata(existingMetadata, prepared.metadata, 'immutable_file_conflict');
        const existingBody = await this.withRetry(
            'Ambiguous Drive create body verification',
            () => this.api.downloadFile(prepared.fileId),
        );
        if (existingBody !== prepared.body || await sha256(existingBody) !== prepared.bodySha256) {
            throw new DriveTransportError('immutable_file_conflict', `Drive file ${prepared.fileId} exists with different immutable bytes`);
        }
    }

    private async withRetry<T>(action: string, operation: () => Promise<T>): Promise<T> {
        for (let attempt = 0; attempt <= DRIVE_RETRY_DELAYS_MS.length; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                const normalized = normalizeDriveError(error, action);
                if (!isRetryableTransportError(normalized) || attempt === DRIVE_RETRY_DELAYS_MS.length) throw normalized;
                await this.sleep(DRIVE_RETRY_DELAYS_MS[attempt]);
            }
        }
        throw new DriveTransportError('transport_retryable', `${action} exhausted its bounded retry budget`);
    }
}
