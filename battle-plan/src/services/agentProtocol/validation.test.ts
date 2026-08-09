/// <reference types="node" />
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    ARTIFACT_MANIFEST_DOMAIN,
    COMMAND_ACTIONS,
    MESSAGE_TYPES,
    PROTOCOL_ERROR_CODES,
    PROTOCOL_VERSION,
    PROTOCOL_RETENTION,
    RESULT_ERROR_CODES,
    RESULT_STATES,
    SIGNING_DOMAIN,
    type ProtocolContractArtifact,
    type TrustedPairingRecord,
    type ProtocolWireMessage,
} from './contracts.ts';
import {
    calculateProtocolConflictSetId,
    calculateEd25519PublicKeyFingerprint,
    calculateProtocolRevisionId,
    canonicalizeProtocolJson,
    createDetachedSignature,
    probeEd25519Support,
    validateProtocolWireMessage,
    verifyCapabilityDriveReceiptLink,
    verifyProtocolWireMessage,
} from './validation.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const protocolRoot = path.resolve(moduleDir, '../../../../docs/agent-protocol/v2');

async function readJson(relativePath: string): Promise<unknown> {
    return JSON.parse(await readFile(path.join(protocolRoot, relativePath), 'utf8')) as unknown;
}

function bytesToBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

async function contractArtifact(): Promise<ProtocolContractArtifact> {
    const manifest = await readJson('ARTIFACT_MANIFEST.json') as {
        artifact_id: string;
        version: string;
        artifact_sha256: `sha256:${string}`;
    };
    assert.equal(manifest.artifact_id, 'battleplan-hermes-protocol');
    assert.equal(manifest.version, PROTOCOL_VERSION);
    return { id: 'battleplan-hermes-protocol', version: PROTOCOL_VERSION, sha256: manifest.artifact_sha256 };
}

async function trustedRecord(
    message: ProtocolWireMessage,
    keys: CryptoKeyPair,
): Promise<TrustedPairingRecord> {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    return {
        status: 'active',
        workspaceId: message.signed.workspace_id,
        producerId: message.signed.producer_id,
        targetId: message.signed.target.id,
        keyId: message.signed.signing_key_id,
        pairingEpoch: message.signed.pairing_epoch,
        rawPublicKey: bytesToBase64Url(raw),
        fingerprint: calculateEd25519PublicKeyFingerprint(raw),
    };
}

test('all valid cross-language fixtures validate and narrow to their message family', async () => {
    for (const messageType of MESSAGE_TYPES) {
        const fixture = await readJson(`fixtures/valid/${messageType}.json`);
        const result = validateProtocolWireMessage(fixture);
        if (!result.ok) assert.fail(`${messageType}: ${result.error.code}`);
        assert.equal(result.message.signed.message_type, messageType);
    }
});

test('invalid and future fixtures fail with their declared stable error code', async () => {
    const fixtureNames = (await readdir(path.join(protocolRoot, 'fixtures/invalid')))
        .filter((name) => name.endsWith('.json'))
        .sort();

    for (const fixtureName of fixtureNames) {
        const fixture = await readJson(`fixtures/invalid/${fixtureName}`) as {
            expected_error?: string;
            message?: unknown;
            cases?: Array<{ name: string; expected_error: string; message: unknown }>;
        };
        const cases = fixture.cases ?? [{ name: fixtureName, expected_error: fixture.expected_error!, message: fixture.message }];
        for (const invalidCase of cases) {
            const result = validateProtocolWireMessage(invalidCase.message);
            assert.equal(result.ok, false, `${fixtureName}/${invalidCase.name} unexpectedly validated`);
            if (!result.ok) assert.equal(result.error.code, invalidCase.expected_error, `${fixtureName}/${invalidCase.name}`);
        }
    }
});

test('applied effects and approval-stale result variants validate', async () => {
    for (const name of ['result-applied.json', 'result-approval-stale.json']) {
        const result = validateProtocolWireMessage(await readJson(`fixtures/valid/${name}`));
        if (!result.ok) assert.fail(`${name}: ${result.error.message}`);
    }
});

test('contract artifact manifest is non-circular, deterministic, and advertised by control messages', async () => {
    const manifest = await readJson('ARTIFACT_MANIFEST.json') as {
        format: string;
        artifact_id: string;
        version: string;
        schemas: Array<{ path: string; bytes: number; sha256: `sha256:${string}` }>;
        artifact_sha256: `sha256:${string}`;
    };
    assert.deepEqual(manifest.schemas.map((entry) => entry.path), [...manifest.schemas.map((entry) => entry.path)].sort());
    for (const entry of manifest.schemas) {
        const bytes = await readFile(path.join(protocolRoot, entry.path));
        assert.equal(entry.bytes, bytes.byteLength, entry.path);
        assert.equal(entry.sha256, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, entry.path);
    }
    const material = {
        format: manifest.format,
        artifact_id: manifest.artifact_id,
        version: manifest.version,
        schemas: manifest.schemas,
    };
    const expected = `sha256:${createHash('sha256').update(`${ARTIFACT_MANIFEST_DOMAIN}${canonicalizeProtocolJson(material)}`, 'utf8').digest('hex')}`;
    assert.equal(manifest.artifact_sha256, expected);
    const advertised = { id: manifest.artifact_id, version: manifest.version, sha256: manifest.artifact_sha256 };
    for (const name of ['hello', 'capability', 'drive-receipt']) {
        const fixture = await readJson(`fixtures/valid/${name}.json`) as ProtocolWireMessage;
        assert.deepEqual((fixture.signed.payload as { contract_artifact: unknown }).contract_artifact, advertised, name);
    }
});

test('v2.0 command registry is explicit and rejects Settings commands', () => {
    assert.deepEqual(COMMAND_ACTIONS, [
        'create_task', 'update_task', 'complete_task', 'archive_task',
        'create_worklog', 'update_worklog', 'delete_worklog',
        'create_project', 'update_project', 'archive_project', 'merge_project',
    ]);
    assert.equal(COMMAND_ACTIONS.some((action) => action.includes('setting')), false);
});

test('RFC 8785 canonical bytes are deterministic and reject unsupported JSON values', () => {
    assert.equal(
        canonicalizeProtocolJson({ z: 1, a: { y: true, x: 'ok' } }),
        '{"a":{"x":"ok","y":true},"z":1}',
    );
    assert.throws(() => canonicalizeProtocolJson({ invalid: Number.NaN }), /finite JSON number/);
    assert.throws(() => canonicalizeProtocolJson({ invalid: undefined }), /JSON value/);
});

test('content digest uses the same domain-separated canonical signed bytes as Ed25519', async () => {
    const fixture = await readJson('fixtures/valid/hello.json') as ProtocolWireMessage;
    const result = validateProtocolWireMessage(fixture);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const expected = `sha256:${createHash('sha256').update(`${SIGNING_DOMAIN}${result.canonicalSignedJson}`, 'utf8').digest('hex')}`;
    assert.equal(result.contentSha256, expected);
});

test('revision and conflict tokens are content-addressed and order-independent where required', () => {
    const material = {
        entity_kind: 'task' as const,
        entity_public_id: 'task_alpha',
        base_revision: null,
        mutation_id: '018f6f5e-2d88-7f2a-8f90-d6ad23000052',
        projection: { title: 'Prepare review', status: 'pending' },
        tombstone: false,
    };
    assert.equal(calculateProtocolRevisionId(material), 'sha256:56e6dfd8a1b5a1dc7a55388867bd07a29b3fd4164791061fb96b833ebf3e412d');
    const heads = [
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ];
    assert.equal(calculateProtocolConflictSetId(heads), calculateProtocolConflictSetId([...heads].reverse()));
    assert.throws(() => calculateProtocolConflictSetId([heads[0]!]), /at least two/);
});

test('snapshot conflict variants retain complete sorted versions and validate their conflict set', async () => {
    const fixture = await readJson('fixtures/valid/snapshot-conflicted.json');
    const result = validateProtocolWireMessage(fixture);
    if (!result.ok) assert.fail(result.error.message);
    if (result.message.signed.message_type !== 'snapshot') return;
    const entity = result.message.signed.payload.entities[0]!;
    assert.equal(entity.state, 'conflicted');
    if (entity.state !== 'conflicted') return;
    assert.equal(entity.conflict_versions.length, 2);
    assert.equal(
        entity.conflict_set_id,
        calculateProtocolConflictSetId(entity.conflict_versions.map((version) => version.revision.revision_id)),
    );

    const revisionMismatch = structuredClone(fixture) as ProtocolWireMessage;
    if (revisionMismatch.signed.message_type !== 'snapshot') return;
    const conflicted = revisionMismatch.signed.payload.entities[0]!;
    if (conflicted.state !== 'conflicted') return;
    conflicted.conflict_versions[0]!.projection = { title: 'Tampered projection' };
    const mismatch = validateProtocolWireMessage(revisionMismatch);
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, 'schema_invalid');
});

test('raw wire parsing rejects duplicate keys and non-canonical whitespace before schema selection', () => {
    const duplicate = validateProtocolWireMessage('{"signature":{},"signed":{"message_type":"hello","message_type":"command"}}');
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, 'duplicate_json_key');

    const whitespace = validateProtocolWireMessage('{ "signature": {}, "signed": {} }');
    assert.equal(whitespace.ok, false);
    if (!whitespace.ok) assert.equal(whitespace.error.code, 'non_canonical_json');
});

test('Ed25519 verification binds canonical body, workspace, key id, and pairing epoch', async (t) => {
    const support = await probeEd25519Support();
    if (support.supported === false) {
        t.skip(`runtime does not support Ed25519: ${support.reason}`);
        return;
    }

    const fixture = await readJson('fixtures/valid/hello.json') as ProtocolWireMessage;
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const message = structuredClone(fixture);
    if (message.signed.message_type !== 'hello') throw new Error('hello fixture has wrong type');
    const trust = await trustedRecord(message, keys);
    message.signed.payload.public_key.raw_public_key = trust.rawPublicKey;
    message.signed.payload.public_key.fingerprint = trust.fingerprint;
    message.signature = await createDetachedSignature(message.signed, keys.privateKey);
    const artifact = await contractArtifact();

    const valid = await verifyProtocolWireMessage(message, {
        trustedPairing: trust,
        trustedContractArtifact: artifact,
    });
    assert.equal(valid.ok, true);

    const tampered: ProtocolWireMessage = {
        ...message,
        signed: { ...message.signed, created_at: '2026-08-09T10:00:01.000Z' },
    };
    const tamperResult = await verifyProtocolWireMessage(tampered, { trustedPairing: trust, trustedContractArtifact: artifact });
    assert.equal(tamperResult.ok, false);
    if (!tamperResult.ok) assert.equal(tamperResult.error.code, 'signature_invalid');

    const workspaceResult = await verifyProtocolWireMessage(message, {
        trustedPairing: { ...trust, workspaceId: '018f6f5e-2d88-7f2a-9f90-d6ad23111111' },
        trustedContractArtifact: artifact,
    });
    assert.equal(workspaceResult.ok, false);
    if (!workspaceResult.ok) assert.equal(workspaceResult.error.code, 'workspace_mismatch');

    const epochMismatch: ProtocolWireMessage = {
        ...message,
        signature: { ...message.signature, pairing_epoch: message.signature.pairing_epoch + 1 },
    };
    const epochResult = await verifyProtocolWireMessage(epochMismatch, { trustedPairing: trust, trustedContractArtifact: artifact });
    assert.equal(epochResult.ok, false);
    if (!epochResult.ok) assert.equal(epochResult.error.code, 'signature_metadata_mismatch');

    const targetResult = await verifyProtocolWireMessage(message, {
        trustedPairing: { ...trust, targetId: 'battleplan.device-b' },
        trustedContractArtifact: artifact,
    });
    assert.equal(targetResult.ok, false);
    if (!targetResult.ok) assert.equal(targetResult.error.code, 'target_mismatch');

    const helloMismatch = structuredClone(message);
    if (helloMismatch.signed.message_type !== 'hello') throw new Error('hello fixture has wrong type');
    helloMismatch.signed.payload.public_key.raw_public_key = bytesToBase64Url(new Uint8Array(32).fill(7));
    helloMismatch.signature = await createDetachedSignature(helloMismatch.signed, keys.privateKey);
    const helloMismatchResult = await verifyProtocolWireMessage(helloMismatch, {
        trustedPairing: trust,
        trustedContractArtifact: artifact,
    });
    assert.equal(helloMismatchResult.ok, false);
    if (!helloMismatchResult.ok) assert.equal(helloMismatchResult.error.code, 'public_key_fingerprint_mismatch');

    const artifactMismatch = structuredClone(message);
    if (artifactMismatch.signed.message_type !== 'hello') throw new Error('hello fixture has wrong type');
    artifactMismatch.signed.payload.contract_artifact.sha256 = `sha256:${'f'.repeat(64)}` as `sha256:${string}`;
    artifactMismatch.signature = await createDetachedSignature(artifactMismatch.signed, keys.privateKey);
    const artifactMismatchResult = await verifyProtocolWireMessage(artifactMismatch, {
        trustedPairing: trust,
        trustedContractArtifact: artifact,
    });
    assert.equal(artifactMismatchResult.ok, false);
    if (!artifactMismatchResult.ok) assert.equal(artifactMismatchResult.error.code, 'contract_artifact_mismatch');
});

test('missing, mismatched and revoked pairing records fail closed before mutation authority is considered', async (t) => {
    const support = await probeEd25519Support();
    if (support.supported === false) { t.skip(support.reason); return; }
    const fixture = await readJson('fixtures/valid/command.json') as ProtocolWireMessage;
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const message = { signed: fixture.signed, signature: await createDetachedSignature(fixture.signed, keys.privateKey) } as ProtocolWireMessage;
    const trust = await trustedRecord(message, keys);
    const artifact = await contractArtifact();
    const unknown = await verifyProtocolWireMessage(message, {} as never);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, 'key_unknown');

    const mismatched = await verifyProtocolWireMessage(message, {
        trustedPairing: { ...trust, keyId: 'ed25519:another-key' },
        trustedContractArtifact: artifact,
    });
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.error.code, 'key_unknown');

    const revoked = await verifyProtocolWireMessage(message, {
        trustedPairing: { ...trust, status: 'revoked' },
        trustedContractArtifact: artifact,
    });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.error.code, 'key_revoked');

    const fingerprintMismatch = await verifyProtocolWireMessage(message, {
        trustedPairing: { ...trust, fingerprint: `sha256:${'f'.repeat(64)}` as `sha256:${string}` },
        trustedContractArtifact: artifact,
    });
    assert.equal(fingerprintMismatch.ok, false);
    if (!fingerprintMismatch.ok) assert.equal(fingerprintMismatch.error.code, 'public_key_fingerprint_mismatch');

    const nonCanonicalPublicKey = await verifyProtocolWireMessage(message, {
        trustedPairing: { ...trust, rawPublicKey: `${trust.rawPublicKey}=` },
        trustedContractArtifact: artifact,
    });
    assert.equal(nonCanonicalPublicKey.ok, false);
    if (!nonCanonicalPublicKey.ok) assert.equal(nonCanonicalPublicKey.error.code, 'public_key_fingerprint_mismatch');
});

test('authenticated expired commands are terminal before any mutation handler', async (t) => {
    const support = await probeEd25519Support();
    if (support.supported === false) {
        t.skip(`runtime does not support Ed25519: ${support.reason}`);
        return;
    }
    const fixture = await readJson('fixtures/valid/command.json') as ProtocolWireMessage;
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const message: ProtocolWireMessage = {
        signed: fixture.signed,
        signature: await createDetachedSignature(fixture.signed, keys.privateKey),
    };
    const result = await verifyProtocolWireMessage(message, {
        trustedPairing: await trustedRecord(message, keys),
        trustedContractArtifact: await contractArtifact(),
        now: new Date('2026-08-10T00:00:00.000Z'),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'message_expired');
});

test('passed capability links to the exact verified drive receipt message and digest', async () => {
    const capability = await readJson('fixtures/valid/capability.json') as ProtocolWireMessage;
    const receipt = await readJson('fixtures/valid/drive-receipt.json') as ProtocolWireMessage;
    const receiptValidation = validateProtocolWireMessage(receipt);
    assert.equal(receiptValidation.ok, true);
    if (!receiptValidation.ok || capability.signed.message_type !== 'capability') return;
    capability.signed.payload.drive_interop_probe = {
        status: 'passed',
        receipt_message_id: receipt.signed.message_id,
        receipt_content_sha256: receiptValidation.contentSha256,
        completed_at: '2026-08-09T10:10:00.000Z',
    };
    assert.equal(verifyCapabilityDriveReceiptLink(capability, receipt).ok, true);
    const passedProbe = capability.signed.payload.drive_interop_probe;
    if (passedProbe.status !== 'passed') throw new Error('capability fixture has wrong probe state');
    passedProbe.receipt_content_sha256 = `sha256:${'f'.repeat(64)}` as `sha256:${string}`;
    const mismatch = verifyCapabilityDriveReceiptLink(capability, receipt);
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, 'drive_receipt_mismatch');
});

test('drive receipt semantic checks preserve both directions and immutable file IDs', async () => {
    const fixture = await readJson('fixtures/valid/drive-receipt.json') as ProtocolWireMessage;
    const reversed = structuredClone(fixture);
    if (reversed.signed.message_type !== 'drive-receipt') return;
    reversed.signed.payload.directions.reverse();
    const reversedResult = validateProtocolWireMessage(reversed);
    assert.equal(reversedResult.ok, false);
    if (!reversedResult.ok) assert.equal(reversedResult.error.code, 'schema_invalid');

    const substituted = structuredClone(fixture);
    if (substituted.signed.message_type !== 'drive-receipt') return;
    substituted.signed.payload.directions[0]!.outcomes.reread.observed_file_id = 'different-file';
    const substitutedResult = validateProtocolWireMessage(substituted);
    assert.equal(substitutedResult.ok, false);
    if (!substitutedResult.ok) assert.equal(substitutedResult.error.code, 'schema_invalid');
});

test('payload size limit fails before schema validation', async () => {
    const fixture = await readJson('fixtures/valid/proposal.json') as ProtocolWireMessage;
    const oversized = structuredClone(fixture);
    if (oversized.signed.message_type !== 'proposal') assert.fail('proposal fixture has wrong type');
    oversized.signed.payload.body = 'x'.repeat(524_289);
    const result = validateProtocolWireMessage(oversized);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'payload_too_large');
});

test('retention boundaries are executable contract constants', () => {
    assert.deepEqual(PROTOCOL_RETENTION, {
        idempotencyDays: 400,
        migrationTombstoneDays: 400,
        eventBatchMinimumDays: 90,
        snapshotMinimumCount: 3,
        snapshotMinimumDays: 30,
        inactiveConsumerResnapshotDays: 90,
        quarantinePayloadDays: 30,
        revokedKeyHistoryDays: 400,
    });
});

test('normative documentation identifiers cannot drift from executable registries', async () => {
    const errorRegistry = await readFile(path.join(protocolRoot, 'ERROR_REGISTRY.md'), 'utf8');
    const lifecycles = await readFile(path.join(protocolRoot, 'MESSAGE_LIFECYCLES.md'), 'utf8');
    const apiReference = await readFile(path.join(protocolRoot, 'API_REFERENCE.md'), 'utf8');

    const documentedErrors = [...errorRegistry.matchAll(/<!-- error-code:([a-z0-9_]+) -->/g)].map((match) => match[1]);
    const documentedStates = [...lifecycles.matchAll(/<!-- result-state:([a-z0-9_]+) -->/g)].map((match) => match[1]);
    const documentedFixtures = [...apiReference.matchAll(/<!-- fixture:([^ ]+\.json) -->/g)].map((match) => match[1]);

    assert.deepEqual(documentedErrors.sort(), [...PROTOCOL_ERROR_CODES].sort());
    assert.deepEqual(documentedStates.sort(), [...RESULT_STATES].sort());
    assert.deepEqual(documentedFixtures.sort(), MESSAGE_TYPES.map((type) => `fixtures/valid/${type}.json`).sort());
    await Promise.all(documentedFixtures.map((fixture) => readJson(fixture)));

    const envelopeSchema = await readJson('schemas/envelope.schema.json') as { properties: { message_type: { enum: string[] } } };
    const commandSchema = await readJson('schemas/command.schema.json') as { $defs: { action: { enum: string[] } } };
    const resultSchema = await readJson('schemas/result.schema.json') as { $defs: { state: { enum: string[] }; errorCode: { enum: string[] } } };
    assert.deepEqual(envelopeSchema.properties.message_type.enum, [...MESSAGE_TYPES]);
    assert.deepEqual(commandSchema.$defs.action.enum, [...COMMAND_ACTIONS]);
    assert.deepEqual(resultSchema.$defs.state.enum, [...RESULT_STATES]);
    assert.deepEqual(resultSchema.$defs.errorCode.enum, [...RESULT_ERROR_CODES]);
});
