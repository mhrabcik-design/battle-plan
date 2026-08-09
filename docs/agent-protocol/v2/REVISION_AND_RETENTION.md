# Revision, conflict and retention contract

## Content-addressed revisions

An entity revision is `{revision_id, base_revision, mutation_id}`. `revision_id` is an opaque `sha256:<64 lowercase hex>` token. Its exact calculation is SHA-256 of UTF-8(`BattlePlan-Hermes/revision/v2\0` + JCS(`{entity_kind,entity_public_id,base_revision,mutation_id,projection,tombstone}`)), with keys canonicalized by RFC 8785. `base_revision` is the exact prior head or `null` for creation. `mutation_id` is a UUID that links the committed event. The executable binding is `calculateProtocolRevisionId()`.

Update/delete/complete/archive/merge commands supply `expected_revision`. The receiver accepts it only when it equals the entity's sole current head. Missing, different or conflicted heads return `revision_stale` or `revision_conflict` with no mutation.

## Concurrent valid events

Two distinct revision IDs with the same `base_revision` form an explicit conflict set. No timestamp, Drive order, producer name or last-writer-wins rule selects a winner. Hermes durably stores both events, pauses canonical application for that entity, and requests a snapshot. The snapshot exposes all conflict heads sorted lexicographically by revision ID.

The conflict-set token is SHA-256 of UTF-8(`BattlePlan-Hermes/conflict/v2\0` + JCS(lexicographically sorted unique head IDs)). Equal canonical projections may be deterministically collapsed into one resolution whose cause cites both heads. Different projections require an explicit domain/human reconciliation. A `conflict_resolved` event must cite every sorted head in `conflict_heads`; its new revision uses the conflict-set token as `base_revision`. Consumers resume only after ingesting that event or a signed snapshot containing it. This rule makes replay and multi-device order deterministic.

## Retention and garbage collection

| Artifact | Minimum retention | Additional GC condition |
| --- | --- | --- |
| Terminal command receipt/idempotency record | 400 days | message is terminal; nonterminal records are never GC'd |
| V1 migration tombstone | 400 days | v1 disabled and legacy backlog proven empty |
| Event batch | 90 days | sequence is below every active consumer checkpoint and covered by a retained signed snapshot |
| Snapshot | latest 3 and 30 days | a newer verified snapshot covers its high-water mark |
| Quarantine raw payload | 30 days | bounded diagnostic metadata/digest remains; secrets are never retained |
| Revoked public-key epoch history | 400 days | no retained artifact can legitimately reference the epoch |

A consumer with no durable checkpoint update for 90 days becomes inactive and must resnapshot before consuming incremental batches. GC never infers acknowledgement from Drive reads or modified time. The idempotency horizon is 400 days: older commands expire before mutation, and producers never reuse message IDs.
