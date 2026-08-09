# Revision, conflict and retention contract

## Content-addressed revisions

An entity revision is `{revision_id, base_revision, mutation_id}`. `revision_id` is an opaque `sha256:<64 lowercase hex>` token. Its exact calculation is SHA-256 of UTF-8(`BattlePlan-Hermes/revision/v2\0` + JCS(`{entity_kind,entity_public_id,base_revision,mutation_id,projection,tombstone}`)), with keys canonicalized by RFC 8785. `base_revision` is the exact prior head or `null` for creation. `mutation_id` is a UUID that links the committed event. The executable binding is `calculateProtocolRevisionId()`.

Update/delete/complete/archive/merge commands supply `expected_revision`. The receiver accepts it only when it equals the entity's sole current head. Missing, different or conflicted heads return `revision_stale` or `revision_conflict` with no mutation.

## Concurrent valid events

Two distinct revision IDs with the same `base_revision` form an explicit conflict set. No timestamp, Drive order, producer name or last-writer-wins rule selects a winner. Hermes durably stores both events, pauses canonical application for that entity, and requests a snapshot. Its `conflicted` entity exposes every head sorted lexicographically by revision ID, with each full revision, projection and tombstone; consumers recompute every revision ID and the aggregate `conflict_set_id` before use.

The conflict-set token is SHA-256 of UTF-8(`BattlePlan-Hermes/conflict/v2\0` + JCS(lexicographically sorted unique head IDs)). Equal canonical projections may be deterministically collapsed into one resolution whose cause cites both heads. Different projections require an explicit domain/human reconciliation. A `conflict_resolved` event must cite every sorted head in `conflict_heads`; its new revision uses the conflict-set token as `base_revision`. Consumers resume only after ingesting that event or a signed snapshot containing it. This rule makes replay and multi-device order deterministic.

## Retention and garbage collection

| Artifact | Minimum retention | Additional GC condition |
| --- | --- | --- |
| Terminal command receipt/idempotency record | 400 days | message is terminal; nonterminal records are never GC'd |
| V1 migration tombstone | 400 days | v1 disabled and legacy backlog proven empty |
| Event batch | 90 days | sequence is below every active consumer checkpoint and covered by a retained signed snapshot |
| Snapshot | latest 3 and 30 days | a newer verified snapshot covers its high-water mark |
| Current signed Drive interoperability receipt | current lifetime | never GC while any capability references it or execution relies on it |
| Superseded signed Drive interoperability receipt | 400 days after supersession | no retained capability references it and both pairing epochs are retained |
| Both signed probe `hello` files named by a Drive receipt | current receipt lifetime plus 400 days after receipt supersession | linked receipt passed retention and stored receipt metadata still contains both immutable hello/file IDs and digests |
| Quarantine raw payload | 30 days | bounded diagnostic metadata/digest remains; secrets are never retained |
| Revoked public-key epoch history | 400 days | no retained artifact can legitimately reference the epoch |
| Inactive-consumer record | until explicit decommission plus 400 days | consumer is still inactive, its key/receiver identity is decommissioned, and any later reuse is forced through fresh pairing and full snapshot |

A consumer with no durable checkpoint update for 90 days becomes inactive and must resnapshot before consuming incremental batches. Merely becoming inactive does not start GC: its record remains indefinitely until an explicit signed/local administrative decommission. The 400-day inactive-record clock starts at that decommission timestamp. After GC, the same producer/receiver/key identifiers are never silently reactivated; any appearance is treated as unpaired and requires fresh pairing plus a full signed snapshot.

A Drive receipt is superseded only when a newer fully verified passed receipt for the same workspace is durably installed and all current capabilities have stopped referencing the old receipt. That durable installation timestamp starts both 400-day clocks. The two probe hello files remain available for the entire current-receipt lifetime and for the full 400 days after supersession; deleting or replacing a Drive file does not shorten this requirement. Failed or partial probes follow quarantine retention and can never supersede a passed receipt.

GC never infers acknowledgement, supersession or decommission from Drive reads, file modified time, absence, account logout or consumer silence. The idempotency horizon is 400 days: older commands expire before mutation, and producers never reuse message IDs.
