/// <reference types="node" />
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    COMMAND_ACTIONS,
    MESSAGE_TYPES,
    PROTOCOL_ERROR_CODES,
    PROTOCOL_RETENTION,
    RESULT_STATES,
    SIGNING_DOMAIN,
    type ProtocolWireMessage,
} from './contracts.ts';
import {
    calculateProtocolConflictSetId,
    calculateProtocolRevisionId,
    canonicalizeProtocolJson,
    createDetachedSignature,
    probeEd25519Support,
    validateProtocolWireMessage,
    verifyProtocolWireMessage,
} from './validation.ts';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const protocolRoot = path.resolve(moduleDir, '../../../../docs/agent-protocol/v2');

async function readJson(relativePath: string): Promise<unknown> {
    return JSON.parse(await readFile(path.join(protocolRoot, relativePath), 'utf8')) as unknown;
}

test('all valid cross-language fixtures validate and narrow to their message family', async () => {
    for (const messageType of MESSAGE_TYPES) {
        const fixture = await readJson(`fixtures/valid/${messageType}.json`);
        const result = validateProtocolWireMessage(fixture);
        assert.equal(result.ok, true, `${messageType}: ${result.ok ? '' : result.error.code}`);
        if (result.ok) assert.equal(result.message.signed.message_type, messageType);
    }
});

test('invalid and future fixtures fail with their declared stable error code', async () => {
    const fixtureNames = (await readdir(path.join(protocolRoot, 'fixtures/invalid')))
        .filter((name) => name.endsWith('.json'))
        .sort();

    for (const fixtureName of fixtureNames) {
        const fixture = await readJson(`fixtures/invalid/${fixtureName}`) as {
            expected_error: string;
            message: unknown;
        };
        const result = validateProtocolWireMessage(fixture.message);
        assert.equal(result.ok, false, `${fixtureName} unexpectedly validated`);
        if (!result.ok) assert.equal(result.error.code, fixture.expected_error, fixtureName);
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
    if (!support.supported) {
        t.skip(`runtime does not support Ed25519: ${support.reason}`);
        return;
    }

    const fixture = await readJson('fixtures/valid/hello.json') as ProtocolWireMessage;
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const signed = await createDetachedSignature(fixture.signed, keys.privateKey);
    const message: ProtocolWireMessage = { signed: fixture.signed, signature: signed };
    const trustedKey = {
        status: 'active' as const,
        keyId: fixture.signed.signing_key_id,
        pairingEpoch: fixture.signed.pairing_epoch,
        publicKey: keys.publicKey,
    };

    const valid = await verifyProtocolWireMessage(message, {
        trustedKey,
        expectedWorkspaceId: fixture.signed.workspace_id,
        expectedProducerId: fixture.signed.producer_id,
    });
    assert.equal(valid.ok, true);

    const tampered: ProtocolWireMessage = {
        ...message,
        signed: { ...message.signed, created_at: '2026-08-09T10:00:01.000Z' },
    };
    const tamperResult = await verifyProtocolWireMessage(tampered, { trustedKey });
    assert.equal(tamperResult.ok, false);
    if (!tamperResult.ok) assert.equal(tamperResult.error.code, 'signature_invalid');

    const workspaceResult = await verifyProtocolWireMessage(message, {
        trustedKey,
        expectedWorkspaceId: '018f6f5e-2d88-7f2a-9f90-d6ad23111111',
    });
    assert.equal(workspaceResult.ok, false);
    if (!workspaceResult.ok) assert.equal(workspaceResult.error.code, 'workspace_mismatch');

    const epochMismatch: ProtocolWireMessage = {
        ...message,
        signature: { ...message.signature, pairing_epoch: message.signature.pairing_epoch + 1 },
    };
    const epochResult = await verifyProtocolWireMessage(epochMismatch, { trustedKey });
    assert.equal(epochResult.ok, false);
    if (!epochResult.ok) assert.equal(epochResult.error.code, 'signature_metadata_mismatch');

    const targetResult = await verifyProtocolWireMessage(message, {
        trustedKey,
        expectedTargetId: 'battleplan.device-b',
    });
    assert.equal(targetResult.ok, false);
    if (!targetResult.ok) assert.equal(targetResult.error.code, 'target_mismatch');
});

test('unknown, mismatched and revoked key records fail closed before mutation authority is considered', async () => {
    const fixture = await readJson('fixtures/valid/hello.json');
    const unknown = await verifyProtocolWireMessage(fixture, {
        trustedKey: { status: 'unknown' },
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, 'key_unknown');

    const message = fixture as ProtocolWireMessage;
    const mismatched = await verifyProtocolWireMessage(message, {
        trustedKey: {
            status: 'active',
            keyId: 'ed25519:another-key',
            pairingEpoch: message.signed.pairing_epoch,
            publicKey: new Uint8Array(32),
        },
    });
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.error.code, 'key_unknown');

    const revoked = await verifyProtocolWireMessage(message, {
        trustedKey: {
            status: 'revoked',
            keyId: message.signed.signing_key_id,
            pairingEpoch: message.signed.pairing_epoch,
            publicKey: new Uint8Array(32),
        },
    });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.error.code, 'key_revoked');
});

test('authenticated expired commands are terminal before any mutation handler', async (t) => {
    const support = await probeEd25519Support();
    if (!support.supported) {
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
        trustedKey: {
            status: 'active',
            keyId: fixture.signed.signing_key_id,
            pairingEpoch: fixture.signed.pairing_epoch,
            publicKey: keys.publicKey,
        },
        now: new Date('2026-08-10T00:00:00.000Z'),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'message_expired');
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
    assert.deepEqual(resultSchema.$defs.errorCode.enum, [...PROTOCOL_ERROR_CODES]);
});
