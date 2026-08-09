import type { ProtocolStandaloneValidator } from './generatedValidators.js';
import {
    validateCapability,
    validateCommand,
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
    type ProtocolErrorCode,
    type ProtocolMessageType,
    type ProtocolRevisionMaterial,
    type ProtocolSignedMessage,
    type ProtocolValidationResult,
    type ProtocolWireMessage,
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
};

class DuplicateJsonKeyError extends Error {}
class CanonicalJsonError extends Error {}

function invalid(code: ProtocolErrorCode, message: string, details?: readonly string[]): ProtocolValidationResult {
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

function signingBytes(signed: ProtocolSignedMessage): { canonical: string; bytes: Uint8Array; digest: string } {
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
        case 'command':
            if (Date.parse(signed.expires_at!) <= Date.parse(signed.created_at)) {
                return invalid('schema_invalid', 'Command expires_at must be later than created_at');
            }
            break;
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
                if (entity.conflict_heads && !isSorted(entity.conflict_heads)) return invalid('schema_invalid', 'Conflict heads must be unique and lexicographically sorted');
                const expected = calculateProtocolRevisionId({
                    entity_kind: entity.entity_kind,
                    entity_public_id: entity.entity_public_id,
                    base_revision: entity.revision.base_revision,
                    mutation_id: entity.revision.mutation_id,
                    projection: entity.projection,
                    tombstone: entity.tombstone ?? false,
                });
                if (entity.revision.revision_id !== expected) return invalid('schema_invalid', 'Snapshot revision_id does not match canonical revision material');
            }
            break;
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
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
    trustedKey:
        | { status: 'unknown' }
        | {
            status: 'active' | 'revoked';
            keyId: string;
            pairingEpoch: number;
            publicKey: CryptoKey | Uint8Array | string;
        };
    expectedWorkspaceId?: string;
    expectedProducerId?: string;
    expectedTargetId?: string;
    now?: Date;
}

export async function verifyProtocolWireMessage(
    input: unknown,
    options: VerifyProtocolOptions,
): Promise<ProtocolValidationResult> {
    const validation = validateProtocolWireMessage(input);
    if (!validation.ok) return validation;
    if (options.trustedKey.status === 'unknown') return invalid('key_unknown', 'Signing key is not paired for this workspace');
    const signed = validation.message.signed;
    if (
        options.trustedKey.keyId !== signed.signing_key_id
        || options.trustedKey.pairingEpoch !== signed.pairing_epoch
    ) {
        return invalid('key_unknown', 'Signing key ID or pairing epoch does not match the trusted pairing record');
    }
    if (options.trustedKey.status === 'revoked') return invalid('key_revoked', 'Signing key or pairing epoch is revoked');
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return invalid('crypto_unsupported', 'WebCrypto Ed25519 is unavailable');
    try {
        let publicKey: CryptoKey;
        if (typeof CryptoKey !== 'undefined' && options.trustedKey.publicKey instanceof CryptoKey) {
            publicKey = options.trustedKey.publicKey;
        } else {
            const publicKeyBytes = typeof options.trustedKey.publicKey === 'string'
                ? base64UrlToBytes(options.trustedKey.publicKey)
                : options.trustedKey.publicKey as Uint8Array;
            publicKey = await subtle.importKey(
                'raw',
                toArrayBuffer(publicKeyBytes),
                { name: 'Ed25519' },
                false,
                ['verify'],
            );
        }
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
        return invalid('crypto_unsupported', error instanceof Error ? error.message : 'Ed25519 verification unavailable');
    }
    if (options.expectedWorkspaceId && signed.workspace_id !== options.expectedWorkspaceId) {
        return invalid('workspace_mismatch', 'Authenticated message belongs to another workspace');
    }
    if (options.expectedProducerId && signed.producer_id !== options.expectedProducerId) {
        return invalid('producer_mismatch', 'Authenticated message belongs to another producer');
    }
    if (options.expectedTargetId && signed.target.id !== options.expectedTargetId) {
        return invalid('target_mismatch', 'Authenticated message targets another receiver or stream');
    }
    if (signed.expires_at && new Date(signed.expires_at).getTime() <= (options.now ?? new Date()).getTime()) {
        return invalid('message_expired', 'Authenticated message is expired');
    }
    return validation;
}
