export const PROTOCOL_VERSION = '2.0.0' as const;
export const PROTOCOL_MAJOR = 2 as const;
export const MAX_PROTOCOL_FILE_BYTES = 524_288 as const;
export const SIGNING_DOMAIN = 'BattlePlan-Hermes/v2\0' as const;
export const REVISION_DOMAIN = 'BattlePlan-Hermes/revision/v2\0' as const;
export const CONFLICT_DOMAIN = 'BattlePlan-Hermes/conflict/v2\0' as const;
export const ARTIFACT_MANIFEST_DOMAIN = 'BattlePlan-Hermes/artifact-manifest/v1\0' as const;

export const MESSAGE_TYPES = [
    'hello',
    'capability',
    'command',
    'result',
    'event-batch',
    'snapshot',
    'proposal',
    'response',
    'drive-receipt',
] as const;
export type ProtocolMessageType = typeof MESSAGE_TYPES[number];

export const COMMAND_ACTIONS = [
    'create_task',
    'update_task',
    'complete_task',
    'archive_task',
    'create_worklog',
    'update_worklog',
    'delete_worklog',
    'create_project',
    'update_project',
    'archive_project',
    'merge_project',
] as const;
export type ProtocolCommandAction = typeof COMMAND_ACTIONS[number];

export const RESULT_STATES = [
    'received',
    'awaiting_approval',
    'retry_scheduled',
    'applied',
    'rejected',
    'expired',
    'blocked',
    'stale',
    'quarantined',
] as const;
export type ProtocolResultState = typeof RESULT_STATES[number];

export const RESULT_ERROR_CODES = [
    'invalid_json', 'duplicate_json_key', 'non_canonical_json', 'payload_too_large', 'schema_invalid',
    'unsupported_major', 'unknown_message_type', 'unknown_action', 'signature_missing', 'signature_invalid',
    'signature_metadata_mismatch', 'public_key_fingerprint_mismatch', 'key_unknown', 'key_revoked',
    'workspace_mismatch', 'producer_mismatch', 'target_mismatch', 'message_expired', 'policy_blocked',
    'capability_blocked', 'revision_stale', 'revision_conflict', 'approval_stale', 'idempotency_conflict',
    'idempotency_horizon_expired', 'transport_retryable', 'external_effect_failed',
] as const;

export const PROTOCOL_ERROR_CODES = [
    'invalid_json',
    'duplicate_json_key',
    'non_canonical_json',
    'payload_too_large',
    'schema_invalid',
    'unsupported_major',
    'unknown_message_type',
    'unknown_action',
    'signature_missing',
    'signature_invalid',
    'signature_metadata_mismatch',
    'public_key_fingerprint_mismatch',
    'contract_artifact_mismatch',
    'crypto_unsupported',
    'key_unknown',
    'key_revoked',
    'workspace_mismatch',
    'producer_mismatch',
    'target_mismatch',
    'message_expired',
    'policy_blocked',
    'capability_blocked',
    'revision_stale',
    'revision_conflict',
    'approval_stale',
    'idempotency_conflict',
    'idempotency_horizon_expired',
    'drive_authorization_failed',
    'drive_workspace_ambiguous',
    'drive_parent_mismatch',
    'drive_receipt_mismatch',
    'transport_retryable',
    'external_effect_failed',
] as const;
export type ProtocolErrorCode = typeof PROTOCOL_ERROR_CODES[number];

export const PROTOCOL_RETENTION = Object.freeze({
    idempotencyDays: 400,
    migrationTombstoneDays: 400,
    eventBatchMinimumDays: 90,
    snapshotMinimumCount: 3,
    snapshotMinimumDays: 30,
    inactiveConsumerResnapshotDays: 90,
    driveReceiptAfterSupersededDays: 400,
    driveProbeHelloAfterReceiptSupersededDays: 400,
    inactiveConsumerRecordAfterDecommissionDays: 400,
    quarantinePayloadDays: 30,
    revokedKeyHistoryDays: 400,
});

export interface ProtocolRevision {
    revision_id: `sha256:${string}`;
    base_revision: `sha256:${string}` | null;
    mutation_id: string;
}

export interface ProtocolRevisionMaterial {
    entity_kind: 'task' | 'worklog' | 'project';
    entity_public_id: string;
    base_revision: `sha256:${string}` | null;
    mutation_id: string;
    projection: Record<string, unknown>;
    tombstone: boolean;
}

export interface ProtocolTarget {
    kind: 'receiver' | 'stream';
    id: string;
}

interface ProtocolSignedBase<TType extends ProtocolMessageType, TPayload> {
    protocol_version: typeof PROTOCOL_VERSION;
    message_type: TType;
    message_id: string;
    workspace_id: string;
    producer_id: string;
    target: ProtocolTarget;
    created_at: string;
    expires_at?: string;
    correlation_id: string | null;
    causation_id: string | null;
    signing_key_id: string;
    pairing_epoch: number;
    payload: TPayload;
}

export interface ProtocolRange {
    minimum: string;
    maximum: string;
}

export interface ProtocolContractArtifact {
    id: 'battleplan-hermes-protocol';
    version: typeof PROTOCOL_VERSION;
    sha256: `sha256:${string}`;
}

export interface TrustedPairingRecord {
    status: 'active' | 'revoked';
    workspaceId: string;
    producerId: string;
    targetId: string;
    keyId: string;
    pairingEpoch: number;
    rawPublicKey: string;
    fingerprint: `sha256:${string}`;
}

export interface HelloPayload {
    contract_artifact: ProtocolContractArtifact;
    role: 'battleplan' | 'hermes';
    purpose: 'pairing' | 'drive_interop_probe';
    protocol_range: ProtocolRange;
    nonce: string;
    public_key: {
        algorithm: 'Ed25519';
        key_id: string;
        pairing_epoch: number;
        raw_public_key: string;
        fingerprint: `sha256:${string}`;
    };
    probe?: {
        probe_id: string;
        direction: 'battleplan_to_hermes' | 'hermes_to_battleplan';
        folder_id: string;
        expected_parent_id: string;
        creator_oauth_client: 'battleplan' | 'hermes';
    };
}

export interface CapabilityPayload {
    contract_artifact: ProtocolContractArtifact;
    receiver_id: string;
    status: 'ready' | 'degraded' | 'disabled';
    protocol_range: ProtocolRange;
    actions: ProtocolCommandAction[];
    policy_revision: string;
    health: {
        paired: boolean;
        transport: 'ready' | 'unavailable' | 'ambiguous';
        execution_enabled: boolean;
        ed25519_supported: boolean;
        checked_at: string;
    };
    drive_interop_probe:
        | { status: 'required' }
        | { status: 'failed'; completed_at: string }
        | {
            status: 'passed';
            receipt_message_id: string;
            receipt_content_sha256: `sha256:${string}`;
            completed_at: string;
        };
}

export type TaskCommandPayload =
    | { action: 'create_task'; input: { title: string; description?: string; deadline?: string } }
    | { action: 'update_task'; public_id: string; expected_revision: string; input: { title?: string; description?: string; deadline?: string } }
    | { action: 'complete_task'; public_id: string; expected_revision: string }
    | { action: 'archive_task'; public_id: string; expected_revision: string; approval_digest: string };

export type WorkLogCommandPayload =
    | { action: 'create_worklog'; input: { project_public_id: string; date: string; hours: number; people: string; description?: string } }
    | { action: 'update_worklog'; public_id: string; expected_revision: string; input: { project_public_id?: string; date?: string; hours?: number; people?: string; description?: string } }
    | { action: 'delete_worklog'; public_id: string; expected_revision: string; approval_digest: string };

export type ProjectCommandPayload =
    | { action: 'create_project'; input: { name: string; color?: string } }
    | { action: 'update_project'; public_id: string; expected_revision: string; input: { name?: string; color?: string } }
    | { action: 'archive_project'; public_id: string; expected_revision: string; approval_digest: string }
    | { action: 'merge_project'; public_id: string; expected_revision: string; source_public_id: string; source_expected_revision: string; approval_digest: string };

export type CommandPayload = TaskCommandPayload | WorkLogCommandPayload | ProjectCommandPayload;

type EffectBase = { effect_id: string; kind: 'calendar' | 'google_tasks' | 'drive_publication' };
export type ProtocolEffect =
    | (EffectBase & { state: 'pending' | 'succeeded' })
    | (EffectBase & { state: 'failed'; error_code: 'transport_retryable' | 'external_effect_failed' });

type ResultBase<TState extends ProtocolResultState> = { command_id: string; state: TState };
export type ResultPayload =
    | ResultBase<'received' | 'awaiting_approval'>
    | (ResultBase<'retry_scheduled'> & { error_code: 'transport_retryable'; retry_at: string })
    | (ResultBase<'applied'> & { entity_public_id: string; revision: ProtocolRevision; effects?: ProtocolEffect[] })
    | (ResultBase<'blocked'> & { error_code: 'policy_blocked' | 'capability_blocked' })
    | (ResultBase<'stale'> & { error_code: 'revision_stale' | 'revision_conflict' | 'approval_stale' })
    | (ResultBase<'expired'> & { error_code: 'message_expired' | 'idempotency_horizon_expired' })
    | (ResultBase<'rejected'> & { error_code: 'idempotency_conflict' })
    | (ResultBase<'quarantined'> & {
        error_code:
            | 'invalid_json' | 'duplicate_json_key' | 'non_canonical_json' | 'payload_too_large'
            | 'schema_invalid' | 'unsupported_major' | 'unknown_message_type' | 'unknown_action'
            | 'signature_missing' | 'signature_invalid' | 'signature_metadata_mismatch'
            | 'public_key_fingerprint_mismatch' | 'key_unknown' | 'key_revoked'
            | 'workspace_mismatch' | 'producer_mismatch' | 'target_mismatch';
    });

export interface EventBatchPayload {
    stream_id: string;
    sequence_from: string;
    sequence_to: string;
    events: Array<{
        event_id: string;
        sequence: string;
        event_type: 'entity_created' | 'entity_updated' | 'entity_deleted' | 'conflict_detected' | 'conflict_resolved';
        entity_kind: 'task' | 'worklog' | 'project';
        entity_public_id: string;
        revision: ProtocolRevision;
        conflict_heads?: string[];
        occurred_at: string;
        actor: string;
        origin: 'ui' | 'voice' | 'hermes' | 'drive' | 'google';
        cause_id: string;
        projection: Record<string, unknown>;
    }>;
}

export interface ResolvedSnapshotEntity {
    state: 'resolved';
    entity_kind: 'task' | 'worklog' | 'project';
    entity_public_id: string;
    revision: ProtocolRevision;
    projection: Record<string, unknown>;
    tombstone: boolean;
}

export interface ConflictedSnapshotEntity {
    state: 'conflicted';
    entity_kind: 'task' | 'worklog' | 'project';
    entity_public_id: string;
    conflict_set_id: `sha256:${string}`;
    conflict_versions: Array<{
        revision: ProtocolRevision;
        projection: Record<string, unknown>;
        tombstone: boolean;
    }>;
}

export interface SnapshotPayload {
    stream_id: string;
    high_water_mark: string;
    generated_at: string;
    entities: Array<ResolvedSnapshotEntity | ConflictedSnapshotEntity>;
}

export interface DriveReceiptPayload {
    contract_artifact: ProtocolContractArtifact;
    verdict: 'passed';
    completed_at: string;
    oauth_scope: 'https://www.googleapis.com/auth/drive.file';
    workspace_location: {
        folder_id: string;
        expected_parent_id: string;
        authority:
            | { kind: 'shared_drive'; drive_id: string }
            | { kind: 'owner'; owner_permission_id: string };
    };
    directions: Array<{
        direction: 'battleplan_to_hermes' | 'hermes_to_battleplan';
        probe_id: string;
        hello_message_id: string;
        file_id: string;
        creator_oauth_client: 'battleplan' | 'hermes';
        body_sha256: `sha256:${string}`;
        signing_key_id: string;
        outcomes: Record<'create' | 'list' | 'get' | 'download' | 'acknowledge' | 'reread', {
            status: 'passed';
            http_status: number;
            observed_file_id: string;
        }>;
        verdicts: Record<'body_digest' | 'signature' | 'properties' | 'parent', 'passed'>;
    }>;
}

export interface ProposalPayload {
    proposal_id: string;
    title: string;
    body: string;
    requested_action: 'accept' | 'reject' | 'defer' | 'convert_to_task';
}

export interface ResponsePayload {
    proposal_id: string;
    decision: 'accepted' | 'rejected' | 'deferred' | 'converted_to_task';
    comment?: string;
    task_public_id?: string;
}

export type HelloMessage = ProtocolSignedBase<'hello', HelloPayload>;
export type CapabilityMessage = ProtocolSignedBase<'capability', CapabilityPayload>;
export type CommandMessage = ProtocolSignedBase<'command', CommandPayload>;
export type ResultMessage = ProtocolSignedBase<'result', ResultPayload>;
export type EventBatchMessage = ProtocolSignedBase<'event-batch', EventBatchPayload>;
export type SnapshotMessage = ProtocolSignedBase<'snapshot', SnapshotPayload>;
export type ProposalMessage = ProtocolSignedBase<'proposal', ProposalPayload>;
export type ResponseMessage = ProtocolSignedBase<'response', ResponsePayload>;
export type DriveReceiptMessage = ProtocolSignedBase<'drive-receipt', DriveReceiptPayload>;

export type ProtocolSignedMessage =
    | HelloMessage
    | CapabilityMessage
    | CommandMessage
    | ResultMessage
    | EventBatchMessage
    | SnapshotMessage
    | ProposalMessage
    | ResponseMessage
    | DriveReceiptMessage;

export interface ProtocolDetachedSignature {
    alg: 'Ed25519';
    key_id: string;
    pairing_epoch: number;
    value: string;
}

export interface ProtocolWireMessage {
    signed: ProtocolSignedMessage;
    signature: ProtocolDetachedSignature;
}

export interface ProtocolValidationError {
    code: ProtocolErrorCode;
    message: string;
    details?: readonly string[];
}

export type ProtocolValidationResult =
    | { ok: true; message: ProtocolWireMessage; canonicalSignedJson: string; contentSha256: `sha256:${string}` }
    | { ok: false; error: ProtocolValidationError };
