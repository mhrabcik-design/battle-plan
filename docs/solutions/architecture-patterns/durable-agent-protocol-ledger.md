---
title: Durable ledger for at-least-once agent commands
date: 2026-08-10
last_updated: 2026-08-11
category: architecture-patterns
module: Agent Collaboration Protocol
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "An external agent sends commands over an at-least-once transport"
  - "Several tabs or devices may poll and process the same command"
  - "A domain mutation must survive crashes independently of network publication"
tags: [agent-protocol, idempotency, indexeddb, outbox, fencing, concurrency]
---

# Durable ledger for at-least-once agent commands

## Context

Google Drive provides transport and discovery, but it does not make a BattlePlan
domain mutation exactly-once. The same signed command may be observed after a
retry, a browser restart, or by overlapping pollers. An in-memory processed-ID
set or a Web Lock can reduce duplicate work, but neither is the durable source of
truth after a crash.

The Agent Collaboration Protocol therefore needs a local ownership boundary
before command execution and a separate, retryable publication boundary after a
mutation commits.

## Guidance

Treat the durable command receipt as the idempotency and ownership record. Claim
a command in a short IndexedDB transaction keyed by receiver and command ID, and
bind that receipt to the canonical payload digest. A replay with the same digest
returns the stored lifecycle; reuse of the command ID with different content
creates one durable conflict result without changing the original receipt. The
implementation snapshots caller-owned input before its first asynchronous
boundary and uses a trusted local clock for lease, expiry, and retry decisions
([ledger.ts](../../../battle-plan/src/services/agentProtocol/ledger.ts)).

Use a lease owner plus a monotonically increasing fencing token for execution.
Every finalization rechecks the complete claim tuple and an unexpired lease. A
late worker that lost its fence must not write the domain mutation, receipt,
event, effect, or outbox.

Commit these records atomically:

- the domain mutation;
- the receipt lifecycle transition and append-only history;
- complete protocol event projections and their per-producer sequence;
- complete protocol result/event payloads in a durable outbox;
- descriptions of external effects that must run later.

`AgentProtocolLedger.commitFencedMutation()` supplies that transaction boundary.
External Drive, Calendar, or Tasks promises must run only after it commits. Their
workers may retry the persisted payload or effect without repeating the domain
mutation. A digest alone is insufficient for an outbox because recovery after a
restart must not depend on reconstructing caller memory.

Persisted protocol payloads must pass the same manifest-covered standalone
validators that peers use. Local TypeScript types and hand-written lifecycle
checks are not sufficient: they can drift on UUID syntax, portable public IDs,
the normative timestamp profile, revision tuples, conflict fields, or batch
limits. Result finalization validates the complete payload and binds all three
revision fields to the receipt result. Event batches are generated inside the
transaction, validated before the domain mutation runs, and capped by the
public contract's 250-event limit
([validation.ts](../../../battle-plan/src/services/agentProtocol/validation.ts)).

Portable entity identities are part of the same correctness model. Local numeric
Dexie keys are not wire identities. Tasks, Projects, and WorkLogs receive stable,
immutable `publicId` values; the unique indexes are introduced only after a
preceding migration repairs missing or duplicate legacy values. WorkLog
`publicId` remains separate from its existing Drive merge identity, `syncId`, so
protocol identity migration cannot silently change Drive synchronization
semantics ([db.ts](../../../battle-plan/src/db.ts)).

Legacy identity repair and unique-index activation need separate schema
versions. A direct upgrade from a database that already reports the old ledger
version may still contain duplicate public IDs. The repair version therefore
keeps indexes non-unique while deterministically replacing duplicates; the next
version introduces unique indexes only after that transaction succeeds. Tests
must cover direct legacy upgrades, numeric local-key preservation, reopen, and
rollback on a failed repair.

Polling coordination is only a local efficiency layer. The shared in-flight
promise and optional Web Lock in
[pollingCoordinator.ts](../../../battle-plan/src/services/agentProtocol/pollingCoordinator.ts)
serialize overlapping polls where possible, while the durable receipt and fence
remain authoritative if a lock is unavailable or a process dies.

## Why This Matters

This split turns an at-least-once transport into deterministic application
behavior without claiming the external system itself is exactly-once. A crash
before the IndexedDB commit leaves no partial domain change. A crash after the
commit leaves a durable outbox/effect record that can be retried. Duplicate or
late workers converge on the receipt lifecycle or lose the fence rather than
mutating twice.

Persisting full events and result payloads also makes restart recovery and Hermes
conformance testable from storage alone. Stable public identities prevent local
row numbers from leaking into the cross-device contract.

Snapshot recovery is a security and atomicity boundary, not a boolean
precondition. The full U1 verifier authenticates the signed snapshot, pairing,
workspace, producer, stream target, and content digest, then mints an immutable
in-process proof that callers cannot manufacture structurally. Installing the
verified projection and advancing the consumer cursor share one IndexedDB
transaction. A crash or incomplete projection leaves both the prior domain state
and `requiresSnapshot` cursor state intact; a high-water mark may never move the
cursor backward.

## When to Apply

- Commands can be redelivered, reordered, or observed by more than one runtime.
- Processing spans a local database transaction and one or more external APIs.
- The sender needs a durable terminal result for success, rejection, expiry, or
  idempotency conflict.
- Entity references must remain stable across devices and local database
  rebuilds.

This pattern does not by itself authorize production execution. Capability
enablement, approval policy, publisher workers, garbage collection, and a live
signed two-party Drive probe remain separate rollout gates.

## Examples

The essential ordering is:

```text
verify envelope and pairing
  -> claim durable receipt (command ID + digest + receiver + lease fence)
  -> apply domain mutation and persist receipt/event/outbox atomically
  -> publish persisted outbox and run persisted effects with bounded retry
  -> mark publication/effects complete in later durable transactions
```

Required regression coverage includes same-digest replay after reopening the
database, conflicting-digest replay producing exactly one result, caller-input
mutation during an asynchronous claim, expired lease fencing, crash rollback,
manifest-exact result and event rejection, the 250-event batch boundary,
cryptographically verified snapshot installation with crash rollback,
outbox/event recovery after restart, duplicate portable identities during
migration, poll rejection cleanup, and operation without Web Locks. The focused
U3 suites live beside
[ledger.test.ts](../../../battle-plan/src/services/agentProtocol/ledger.test.ts),
[dbMigration.test.ts](../../../battle-plan/src/dbMigration.test.ts), and
[pollingCoordinator.test.ts](../../../battle-plan/src/services/agentProtocol/pollingCoordinator.test.ts).

## Related

- [Agent Protocol v2 documentation](../../agent-protocol/v2/README.md)
- [Agent Protocol v2 threat model](../../agent-protocol/v2/THREAT_MODEL.md)
