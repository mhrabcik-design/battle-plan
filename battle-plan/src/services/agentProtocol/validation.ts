import type { ProtocolStandaloneValidator } from './generatedValidators.js';
import {
    validateCapability,
    validateCommand,
    validateDriveReceipt,
    validateEventBatch,
    validateHello,
    validateProposal,
    validateResponse,
    validateResult,
    validateSnapshot,
} from './generatedValidators.js';
import {
    COMMAND_ACTIONS,
    CONFLICT_DOMAIN,
    MAX_PROTOCOL_FILE_BYTES,
    MESSAGE_TYPES,
    PROTOCOL_MAJOR,
    REVISION_DOMAIN,
    SIGNING_DOMAIN,
    type ProtocolDetachedSignature,
    type ProtocolContractArtifact,
    type ProtocolErrorCode,
    type EventBatchPayload,
    type ProtocolMessageType,
    type ProtocolRevisionMaterial,
    type ResultPayload,
    type SnapshotPayload,
    type ProtocolSignedMessage,
    type ProtocolValidationResult,
    type ProtocolWireMessage,
    type TrustedPairingRecord,
} from './contracts.ts';

const encoder = new TextEncoder();
const validators: Record<ProtocolMessageType, ProtocolStandaloneValidator> = {
    hello: validateHello,
    capability: validateCapability,
    command: validateCommand,
    result: validateResult,
    'event-batch': validateEventBatch,
    snapshot: validateSnapshot,
    proposal: validateProposal,
    response: validateResponse,
    'drive-receipt': validateDriveReceipt,
};

const PAYLOAD_VALIDATION_UUID = '018f6f5e-2d88-7f2a-8f90-d6ad23000999';

function payloadValidationEnvelope(
    messageType: 'result' | 'event-batch',
    targetKind: 'receiver' | 'stream',
    payload: unknown,
): unknown {
    return {
        signed: {
            protocol_version: '2.0.0',
            message_type: messageType,
            message_id: PAYLOAD_VALIDATION_UUID,
            workspace_id: PAYLOAD_VALIDATION_UUID,
            producer_id: 'validation-producer',
            target: { kind: targetKind, id: 'validation-target' },
            created_at: '2026-01-01T00:00:00Z',
            correlation_id: null,
            causation_id: null,
            signing_key_id: 'ed25519:validation-key',
            pairing_epoch: 1,
            payload,
        },
        signature: {
            alg: 'Ed25519',
            key_id: 'ed25519:validation-key',
            pairing_epoch: 1,
            value: 'AA',
        },
    };
}

/** Uses the manifest-covered standalone schema as the structural authority. */
export function validateResultPayloadContract(payload: unknown): payload is ResultPayload {
    return validateResult(payloadValidationEnvelope('result', 'receiver', payload));
}

/** Uses the manifest-covered standalone schema as the structural authority. */
export function validateEventBatchPayloadContract(payload: unknown): payload is EventBatchPayload {
    return validateEventBatch(payloadValidationEnvelope('event-batch', 'stream', payload));
}

class DuplicateJsonKeyError extends Error {}
class CanonicalJsonError extends Error {}

function invalid(
    code: ProtocolErrorCode,
    message: string,
    details?: readonly string[],
): Extract<ProtocolValidationResult, { ok: false }> {
    return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function assertUnicodeScalarString(value: string): void {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalJsonError('JSON strings must not contain lone surrogates');
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new CanonicalJsonError('JSON strings must not contain lone surrogates');
        }
    }
}

function canonicalize(value: unknown, seen: Set<object>): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') {
        assertUnicodeScalarString(value);
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new CanonicalJsonError('Protocol JSON requires a finite JSON number');
        if (Object.is(value, -0)) throw new CanonicalJsonError('Protocol JSON rejects negative zero');
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
            throw new CanonicalJsonError('Unsafe integers must be encoded as decimal strings');
        }
        return JSON.stringify(value);
    }
    if (typeof value !== 'object') throw new CanonicalJsonError('Unsupported JSON value');
    if (seen.has(value)) throw new CanonicalJsonError('Cyclic values are not JSON');
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const items = value.map((item, index) => {
                if (!Object.hasOwn(value, index)) throw new CanonicalJsonError('Sparse arrays are not protocol JSON');
                return canonicalize(item, seen);
            });
            return `[${items.join(',')}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new CanonicalJsonError('Protocol JSON objects must be plain objects');
        }
        const object = value as Record<string, unknown>;
        const keys = Object.keys(object).sort();
        const properties = keys.map((key) => {
            assertUnicodeScalarString(key);
            return `${JSON.stringify(key)}:${canonicalize(object[key], seen)}`;
        });
        return `{${properties.join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

/** RFC 8785 JCS with fail-closed guards for -0, unsafe integers and lone surrogates. */
export function canonicalizeProtocolJson(value: unknown): string {
    return canonicalize(value, new Set());
}

function assertNoDuplicateObjectKeys(source: string): void {
    let index = 0;
    const skipWhitespace = (): void => {
        while (/\s/.test(source[index] ?? '')) index++;
    };
    const parseString = (): string => {
        const start = index;
        if (source[index++] !== '"') throw new SyntaxError('Expected JSON string');
        while (index < source.length) {
            const character = source[index++];
            if (character === '"') return JSON.parse(source.slice(start, index)) as string;
            if (character === '\\') {
                const escape = source[index++];
                if (escape === 'u') index += 4;
            }
        }
        throw new SyntaxError('Unterminated JSON string');
    };
    const parseValue = (): void => {
        skipWhitespace();
        const character = source[index];
        if (character === '{') {
            index++;
            skipWhitespace();
            const keys = new Set<string>();
            if (source[index] === '}') { index++; return; }
            while (index < source.length) {
                skipWhitespace();
                const key = parseString();
                if (keys.has(key)) throw new DuplicateJsonKeyError(`Duplicate JSON key: ${key}`);
                keys.add(key);
                skipWhitespace();
                if (source[index++] !== ':') throw new SyntaxError('Expected colon');
                parseValue();
                skipWhitespace();
                if (source[index] === '}') { index++; return; }
                if (source[index++] !== ',') throw new SyntaxError('Expected comma');
            }
            throw new SyntaxError('Unterminated JSON object');
        }
        if (character === '[') {
            index++;
            skipWhitespace();
            if (source[index] === ']') { index++; return; }
            while (index < source.length) {
                parseValue();
                skipWhitespace();
                if (source[index] === ']') { index++; return; }
                if (source[index++] !== ',') throw new SyntaxError('Expected comma');
            }
            throw new SyntaxError('Unterminated JSON array');
        }
        if (character === '"') { parseString(); return; }
        const remainder = source.slice(index);
        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(remainder)?.[0];
        if (!token) throw new SyntaxError('Invalid JSON value');
        index += token.length;
    };
    parseValue();
    skipWhitespace();
    if (index !== source.length) throw new SyntaxError('Trailing JSON content');
}

function parseProtocolJson(source: string): { value?: unknown; error?: ProtocolValidationResult } {
    try {
        assertNoDuplicateObjectKeys(source);
        const value = JSON.parse(source) as unknown;
        if (canonicalizeProtocolJson(value) !== source) {
            return { error: invalid('non_canonical_json', 'Wire JSON must use RFC 8785 canonical representation') };
        }
        return { value };
    } catch (error) {
        if (error instanceof DuplicateJsonKeyError) {
            return { error: invalid('duplicate_json_key', error.message) };
        }
        if (error instanceof CanonicalJsonError) {
            return { error: invalid('non_canonical_json', error.message) };
        }
        return { error: invalid('invalid_json', error instanceof Error ? error.message : 'Invalid JSON') };
    }
}

function rotateRight(value: number, count: number): number {
    return (value >>> count) | (value << (32 - count));
}

// Small synchronous SHA-256 keeps structural validation usable in browsers without Node polyfills.
function sha256Hex(bytes: Uint8Array): string {
    const constants = new Uint32Array(64);
    const initial = new Uint32Array(8);
    const isComposite = new Uint8Array(312);
    let primeCount = 0;
    for (let candidate = 2; primeCount < 64; candidate++) {
        if (isComposite[candidate]) continue;
        for (let multiple = candidate * candidate; multiple < isComposite.length; multiple += candidate) isComposite[multiple] = 1;
        const squareFraction = Math.sqrt(candidate) % 1;
        const cubeFraction = Math.cbrt(candidate) % 1;
        if (primeCount < 8) initial[primeCount] = (squareFraction * 0x100000000) >>> 0;
        constants[primeCount++] = (cubeFraction * 0x100000000) >>> 0;
    }
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    const hash = new Uint32Array(initial);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
        for (let index = 16; index < 64; index++) {
            const s0 = rotateRight(words[index - 15]!, 7) ^ rotateRight(words[index - 15]!, 18) ^ (words[index - 15]! >>> 3);
            const s1 = rotateRight(words[index - 2]!, 17) ^ rotateRight(words[index - 2]!, 19) ^ (words[index - 2]! >>> 10);
            words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index++) {
            const sigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
            const choice = (e! & f!) ^ (~e! & g!);
            const temp1 = (h! + sigma1 + choice + constants[index]! + words[index]!) >>> 0;
            const sigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
            const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
            const temp2 = (sigma0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d! + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0;
        hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0;
        hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0;
        hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
    }
    return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function signingBytes(signed: ProtocolSignedMessage): { canonical: string; bytes: Uint8Array; digest: `sha256:${string}` } {
    const canonical = canonicalizeProtocolJson(signed);
    const bytes = encoder.encode(`${SIGNING_DOMAIN}${canonical}`);
    return { canonical, bytes, digest: `sha256:${sha256Hex(bytes)}` };
}

export function calculateProtocolRevisionId(material: ProtocolRevisionMaterial): `sha256:${string}` {
    return `sha256:${sha256Hex(encoder.encode(`${REVISION_DOMAIN}${canonicalizeProtocolJson(material)}`))}`;
}

export function calculateProtocolConflictSetId(heads: readonly string[]): `sha256:${string}` {
    const sorted = [...new Set(heads)].sort();
    if (sorted.length < 2) throw new Error('A protocol conflict set requires at least two distinct heads');
    return `sha256:${sha256Hex(encoder.encode(`${CONFLICT_DOMAIN}${canonicalizeProtocolJson(sorted)}`))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSorted(values: readonly string[]): boolean {
    return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function semanticError(wire: ProtocolWireMessage): ProtocolValidationResult | undefined {
    const { signed } = wire;
    switch (signed.message_type) {
        case 'hello':
            if (signed.payload.public_key.key_id !== signed.signing_key_id || signed.payload.public_key.pairing_epoch !== signed.pairing_epoch) {
                return invalid('signature_metadata_mismatch', 'Hello public-key assertion must match signed key metadata');
            }
            break;
        case 'command': {
            const createdAt = Date.parse(signed.created_at);
            const expiresAt = Date.parse(signed.expires_at!);
            if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
                return invalid('schema_invalid', 'Command timestamps must be safely comparable RFC 3339 values');
            }
            if (expiresAt <= createdAt) {
                return invalid('schema_invalid', 'Command expires_at must be later than created_at');
            }
            break;
        }
        case 'result':
            if (signed.correlation_id !== signed.payload.command_id) {
                return invalid('schema_invalid', 'Result correlation_id must equal payload.command_id');
            }
            break;
        case 'event-batch': {
            const { events, sequence_from: from, sequence_to: to, stream_id: streamId } = signed.payload;
            if (streamId !== signed.target.id) return invalid('schema_invalid', 'Event stream_id must equal target.id');
            const first = BigInt(from);
            if (events[0]!.sequence !== from || events.at(-1)!.sequence !== to) {
                return invalid('schema_invalid', 'Event batch boundaries must match first and last event sequence');
            }
            for (let index = 0; index < events.length; index++) {
                const event = events[index]!;
                if (BigInt(event.sequence) !== first + BigInt(index)) return invalid('schema_invalid', 'Event sequences must be contiguous');
                if (event.conflict_heads && !isSorted(event.conflict_heads)) return invalid('schema_invalid', 'Conflict heads must be unique and lexicographically sorted');
                const expected = calculateProtocolRevisionId({
                    entity_kind: event.entity_kind,
                    entity_public_id: event.entity_public_id,
                    base_revision: event.revision.base_revision,
                    mutation_id: event.revision.mutation_id,
                    projection: event.projection,
                    tombstone: event.event_type === 'entity_deleted',
                });
                if (event.revision.revision_id !== expected) return invalid('schema_invalid', 'Event revision_id does not match canonical revision material');
            }
            break;
        }
        case 'snapshot':
            if (signed.payload.stream_id !== signed.target.id) return invalid('schema_invalid', 'Snapshot stream_id must equal target.id');
            for (const entity of signed.payload.entities) {
                if (entity.state === 'resolved') {
                    const expected = calculateProtocolRevisionId({
                        entity_kind: entity.entity_kind,
                        entity_public_id: entity.entity_public_id,
                        base_revision: entity.revision.base_revision,
                        mutation_id: entity.revision.mutation_id,
                        projection: entity.projection,
                        tombstone: entity.tombstone,
                    });
                    if (entity.revision.revision_id !== expected) return invalid('schema_invalid', 'Resolved snapshot revision_id does not match canonical revision material');
                    continue;
                }
                const heads = entity.conflict_versions.map((version) => version.revision.revision_id);
                if (!isSorted(heads)) return invalid('schema_invalid', 'Snapshot conflict versions must be unique and lexicographically sorted by revision_id');
                const bases = new Set(entity.conflict_versions.map((version) => version.revision.base_revision));
                if (bases.size !== 1) return invalid('schema_invalid', 'Snapshot conflict versions must share one base_revision');
                for (const version of entity.conflict_versions) {
                    const expected = calculateProtocolRevisionId({
                        entity_kind: entity.entity_kind,
                        entity_public_id: entity.entity_public_id,
                        base_revision: version.revision.base_revision,
                        mutation_id: version.revision.mutation_id,
                        projection: version.projection,
                        tombstone: version.tombstone,
                    });
                    if (version.revision.revision_id !== expected) return invalid('schema_invalid', 'Snapshot conflict revision_id does not match canonical revision material');
                }
                if (entity.conflict_set_id !== calculateProtocolConflictSetId(heads)) {
                    return invalid('schema_invalid', 'Snapshot conflict_set_id does not match the complete sorted head set');
                }
            }
            break;
        case 'drive-receipt': {
            const expectedDirections = ['battleplan_to_hermes', 'hermes_to_battleplan'] as const;
            const operations = ['create', 'list', 'get', 'download', 'acknowledge', 'reread'] as const;
            for (let index = 0; index < expectedDirections.length; index++) {
                const direction = signed.payload.directions[index]!;
                if (direction.direction !== expectedDirections[index]) {
                    return invalid('schema_invalid', 'Drive receipt directions must be complete and ordered battleplan_to_hermes, hermes_to_battleplan');
                }
                const expectedCreator = direction.direction === 'battleplan_to_hermes' ? 'battleplan' : 'hermes';
                if (direction.creator_oauth_client !== expectedCreator) {
                    return invalid('schema_invalid', 'Drive receipt direction must match its OAuth creator');
                }
                for (const operation of operations) {
                    if (direction.outcomes[operation].observed_file_id !== direction.file_id) {
                        return invalid('schema_invalid', `Drive receipt ${operation} outcome must preserve the immutable file_id`);
                    }
                }
            }
            break;
        }
        default:
            break;
    }
    return undefined;
}

export function validateProtocolWireMessage(input: unknown): ProtocolValidationResult {
    let value = input;
    if (typeof input === 'string') {
        if (encoder.encode(input).byteLength > MAX_PROTOCOL_FILE_BYTES) return invalid('payload_too_large', 'Protocol file exceeds 524288 bytes');
        const parsed = parseProtocolJson(input);
        if (parsed.error) return parsed.error;
        value = parsed.value;
    }
    let canonicalWire: string;
    try {
        canonicalWire = canonicalizeProtocolJson(value);
    } catch (error) {
        return invalid('non_canonical_json', error instanceof Error ? error.message : 'Value is not canonical JSON');
    }
    if (encoder.encode(canonicalWire).byteLength > MAX_PROTOCOL_FILE_BYTES) return invalid('payload_too_large', 'Protocol file exceeds 524288 bytes');
    if (!isRecord(value) || !isRecord(value.signed)) return invalid('schema_invalid', 'Wire message must contain a signed object');
    if (!isRecord(value.signature)) return invalid('signature_missing', 'Wire message requires an Ed25519 signature object');
    const signed = value.signed;
    const version = signed.protocol_version;
    if (typeof version === 'string') {
        const major = /^([0-9]+)\./.exec(version)?.[1];
        if (major !== undefined && Number(major) !== PROTOCOL_MAJOR) return invalid('unsupported_major', `Unsupported protocol major ${major}`);
    }
    const type = signed.message_type;
    if (typeof type !== 'string' || !MESSAGE_TYPES.includes(type as ProtocolMessageType)) {
        return invalid('unknown_message_type', `Unknown message type ${String(type)}`);
    }
    if (type === 'command' && isRecord(signed.payload)) {
        const action = signed.payload.action;
        if (typeof action !== 'string' || !COMMAND_ACTIONS.includes(action as typeof COMMAND_ACTIONS[number])) {
            return invalid('unknown_action', `Unknown or forbidden command action ${String(action)}`);
        }
    }
    const validator = validators[type as ProtocolMessageType];
    if (!validator(value)) {
        const details = (validator.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
        return invalid('schema_invalid', 'Message does not match its normative schema', details);
    }
    const wire = value as unknown as ProtocolWireMessage;
    if (wire.signed.signing_key_id !== wire.signature.key_id || wire.signed.pairing_epoch !== wire.signature.pairing_epoch) {
        return invalid('signature_metadata_mismatch', 'Signed key metadata must match detached signature metadata');
    }
    const semantics = semanticError(wire);
    if (semantics) return semantics;
    const signedCanonical = signingBytes(wire.signed);
    return {
        ok: true,
        message: wire,
        canonicalSignedJson: signedCanonical.canonical,
        contentSha256: signedCanonical.digest,
    };
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
        throw new Error('Value is not unpadded base64url');
    }
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytesToBase64Url(bytes) !== value) throw new Error('Value is not canonical base64url');
    return bytes;
}

/** SHA-256 fingerprint over the exact 32 raw Ed25519 public-key bytes. */
export function calculateEd25519PublicKeyFingerprint(rawPublicKey: Uint8Array | string): `sha256:${string}` {
    const bytes = typeof rawPublicKey === 'string' ? base64UrlToBytes(rawPublicKey) : rawPublicKey;
    return `sha256:${sha256Hex(bytes)}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

export async function probeEd25519Support(): Promise<{ supported: true } | { supported: false; reason: string }> {
    try {
        if (!globalThis.crypto?.subtle) return { supported: false, reason: 'WebCrypto unavailable' };
        await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
        return { supported: true };
    } catch (error) {
        return { supported: false, reason: error instanceof Error ? error.message : 'Ed25519 unavailable' };
    }
}

export async function createDetachedSignature(
    signed: ProtocolSignedMessage,
    privateKey: CryptoKey,
): Promise<ProtocolDetachedSignature> {
    const { bytes } = signingBytes(signed);
    const signature = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, privateKey, toArrayBuffer(bytes));
    return {
        alg: 'Ed25519',
        key_id: signed.signing_key_id,
        pairing_epoch: signed.pairing_epoch,
        value: bytesToBase64Url(new Uint8Array(signature)),
    };
}

export interface VerifyProtocolOptions {
    trustedPairing: TrustedPairingRecord;
    trustedContractArtifact: ProtocolContractArtifact;
    now?: Date;
}

function sameContractArtifact(actual: ProtocolContractArtifact, expected: ProtocolContractArtifact): boolean {
    return actual.id === expected.id && actual.version === expected.version && actual.sha256 === expected.sha256;
}

function assertedContractArtifact(message: ProtocolSignedMessage): ProtocolContractArtifact | undefined {
    switch (message.message_type) {
        case 'hello':
        case 'capability':
        case 'drive-receipt':
            return message.payload.contract_artifact;
        default:
            return undefined;
    }
}

export async function verifyProtocolWireMessage(
    input: unknown,
    options: VerifyProtocolOptions,
): Promise<ProtocolValidationResult> {
    const validation = validateProtocolWireMessage(input);
    if (!validation.ok) return validation;
    if (!options?.trustedPairing) return invalid('key_unknown', 'A trusted pairing record is required');
    const trust = options.trustedPairing;
    const signed = validation.message.signed;
    if (
        trust.keyId !== signed.signing_key_id
        || trust.pairingEpoch !== signed.pairing_epoch
    ) {
        return invalid('key_unknown', 'Signing key ID or pairing epoch does not match the trusted pairing record');
    }
    if (trust.status === 'revoked') return invalid('key_revoked', 'Signing key or pairing epoch is revoked');
    let publicKeyBytes: Uint8Array;
    try {
        publicKeyBytes = base64UrlToBytes(trust.rawPublicKey);
    } catch {
        return invalid('public_key_fingerprint_mismatch', 'Trusted raw public key is not valid base64url');
    }
    if (publicKeyBytes.byteLength !== 32) {
        return invalid('public_key_fingerprint_mismatch', 'Trusted Ed25519 raw public key must be exactly 32 bytes');
    }
    const actualFingerprint = calculateEd25519PublicKeyFingerprint(publicKeyBytes);
    if (trust.fingerprint !== actualFingerprint) {
        return invalid('public_key_fingerprint_mismatch', 'Trusted fingerprint does not match the trusted raw public key bytes');
    }
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return invalid('crypto_unsupported', 'WebCrypto Ed25519 is unavailable');
    try {
        const publicKey = await subtle.importKey(
            'raw',
            toArrayBuffer(publicKeyBytes),
            { name: 'Ed25519' },
            false,
            ['verify'],
        );
        const { bytes } = signingBytes(validation.message.signed);
        let signatureBytes: Uint8Array;
        try {
            signatureBytes = base64UrlToBytes(validation.message.signature.value);
        } catch {
            return invalid('signature_invalid', 'Ed25519 signature is not valid base64url');
        }
        if (signatureBytes.byteLength !== 64) return invalid('signature_invalid', 'Ed25519 signature must be 64 bytes');
        const verified = await subtle.verify(
            { name: 'Ed25519' },
            publicKey,
            toArrayBuffer(signatureBytes),
            toArrayBuffer(bytes),
        );
        if (!verified) return invalid('signature_invalid', 'Ed25519 signature does not match canonical signed bytes');
    } catch (error) {
        if (error instanceof DOMException && error.name === 'NotSupportedError') {
            return invalid('crypto_unsupported', error.message || 'Ed25519 verification unavailable');
        }
        return invalid('signature_invalid', error instanceof Error ? error.message : 'Ed25519 verification failed');
    }
    if (signed.workspace_id !== trust.workspaceId) {
        return invalid('workspace_mismatch', 'Authenticated message belongs to another workspace');
    }
    if (signed.producer_id !== trust.producerId) {
        return invalid('producer_mismatch', 'Authenticated message belongs to another producer');
    }
    if (signed.target.id !== trust.targetId) {
        return invalid('target_mismatch', 'Authenticated message targets another receiver or stream');
    }
    if (signed.message_type === 'hello') {
        let assertedBytes: Uint8Array;
        try {
            assertedBytes = base64UrlToBytes(signed.payload.public_key.raw_public_key);
        } catch {
            return invalid('public_key_fingerprint_mismatch', 'Hello raw public key is not valid base64url');
        }
        const assertedFingerprint = calculateEd25519PublicKeyFingerprint(assertedBytes);
        if (
            signed.payload.public_key.raw_public_key !== trust.rawPublicKey
            || assertedFingerprint !== trust.fingerprint
            || signed.payload.public_key.fingerprint !== trust.fingerprint
        ) {
            return invalid('public_key_fingerprint_mismatch', 'Hello public key bytes and fingerprint must match the trusted pairing record');
        }
    }
    const advertisedArtifact = assertedContractArtifact(signed);
    if (
        advertisedArtifact
        && (!options.trustedContractArtifact || !sameContractArtifact(advertisedArtifact, options.trustedContractArtifact))
    ) {
        return invalid('contract_artifact_mismatch', 'Authenticated control message advertises a different normative contract artifact');
    }
    if (signed.expires_at) {
        const expiresAt = Date.parse(signed.expires_at);
        const now = (options.now ?? new Date()).getTime();
        if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) {
            return invalid('schema_invalid', 'Expiry and verifier clock must be safely comparable timestamps');
        }
        if (expiresAt <= now) return invalid('message_expired', 'Authenticated message is expired');
    }
    return validation;
}

export interface VerifiedSnapshotProof {
    readonly contentSha256: `sha256:${string}`;
    readonly workspaceId: string;
    readonly producerId: string;
    readonly targetStreamId: string;
    readonly signingKeyId: string;
    readonly pairingEpoch: number;
    readonly payload: SnapshotPayload;
}

export type VerifySnapshotForInstallResult =
    | { ok: true; proof: VerifiedSnapshotProof }
    | Extract<ProtocolValidationResult, { ok: false }>;

const verifiedSnapshotProofs = new WeakSet<object>();

function deepFreezeProtocolValue<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreezeProtocolValue(child);
    return Object.freeze(value);
}

/**
 * Mints an in-process recovery capability only after the complete U1 verifier
 * authenticates one immutable snapshot and binds its target to its stream.
 */
export async function verifySnapshotForInstall(
    input: unknown,
    options: VerifyProtocolOptions,
): Promise<VerifySnapshotForInstallResult> {
    const verification = await verifyProtocolWireMessage(input, options);
    if (verification.ok === false) return verification;
    const signed = verification.message.signed;
    if (signed.message_type !== 'snapshot') {
        return invalid('schema_invalid', 'Snapshot recovery requires a signed snapshot message');
    }
    if (signed.target.kind !== 'stream' || signed.target.id !== signed.payload.stream_id) {
        return invalid('target_mismatch', 'Snapshot target and payload stream must match');
    }
    const proof = deepFreezeProtocolValue<VerifiedSnapshotProof>({
        contentSha256: verification.contentSha256,
        workspaceId: signed.workspace_id,
        producerId: signed.producer_id,
        targetStreamId: signed.target.id,
        signingKeyId: signed.signing_key_id,
        pairingEpoch: signed.pairing_epoch,
        payload: structuredClone(signed.payload),
    });
    verifiedSnapshotProofs.add(proof);
    return { ok: true, proof };
}

export function isVerifiedSnapshotProof(value: unknown): value is VerifiedSnapshotProof {
    return typeof value === 'object' && value !== null && verifiedSnapshotProofs.has(value);
}

export interface VerifyCapabilityDriveReceiptLinkOptions {
    capability: VerifyProtocolOptions;
    receipt: VerifyProtocolOptions;
}

export async function verifyCapabilityDriveReceiptLink(
    capability: unknown,
    receipt: unknown,
    options: VerifyCapabilityDriveReceiptLinkOptions,
): Promise<ProtocolValidationResult> {
    const capabilityValidation = await verifyProtocolWireMessage(capability, options?.capability);
    if (!capabilityValidation.ok) return capabilityValidation;
    const receiptValidation = await verifyProtocolWireMessage(receipt, options?.receipt);
    if (!receiptValidation.ok) return receiptValidation;
    const capabilityMessage = capabilityValidation.message.signed;
    const receiptMessage = receiptValidation.message.signed;
    if (capabilityMessage.message_type !== 'capability' || receiptMessage.message_type !== 'drive-receipt') {
        return invalid('drive_receipt_mismatch', 'Link verification requires capability and drive-receipt messages');
    }
    const probe = capabilityMessage.payload.drive_interop_probe;
    if (
        probe.status !== 'passed'
        || capabilityMessage.workspace_id !== receiptMessage.workspace_id
        || probe.receipt_message_id !== receiptMessage.message_id
        || probe.receipt_content_sha256 !== receiptValidation.contentSha256
        || probe.completed_at !== receiptMessage.payload.completed_at
        || !sameContractArtifact(capabilityMessage.payload.contract_artifact, receiptMessage.payload.contract_artifact)
    ) {
        return invalid('drive_receipt_mismatch', 'Capability does not link the exact passed receipt ID, digest, completion time, workspace, and contract artifact');
    }
    return receiptValidation;
}
