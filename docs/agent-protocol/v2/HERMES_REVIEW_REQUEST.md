# Hermes review request — protocol v2 U1

Review branch `codex/hermes-collaboration-protocol` at the commit that contains this file. This package is contract-ready, not cutover-ready. Production command execution must remain disabled.

## Required inputs

Read the complete `docs/agent-protocol/v2/` directory. Start with `README.md` and follow its listed document order. The normative sources are the JSON Schemas, registries, fixtures, and generated standalone validators; prose must not override them.

## Conformance command

From the repository root, run:

```sh
node docs/agent-protocol/v2/conformance.mjs
```

Expected result:

```text
BattlePlan-Hermes v2 source-independent schema conformance: 18 fixtures passed.
```

Hermes must also validate every fixture with its own implementation. It must not import BattlePlan TypeScript as its protocol implementation.

## Required review decisions

Confirm or reject each item with an exact file, JSON path or field, observed behavior, and proposed correction:

1. BattlePlan and Hermes own separate Ed25519 keypairs. Pairing binds public-key fingerprint, key ID, pairing epoch, producer, receiver, and workspace. Unknown, mismatched, rolled-back, or revoked epochs fail closed.
2. Ed25519 and SHA-256 use the same domain-separated UTF-8 bytes of the RFC 8785 canonical `signed` body. Drive properties are non-authoritative hints.
3. Entity revisions are content-addressed. Concurrent heads create an explicit deterministic conflict set; no timestamp, Drive order, producer name, or last-writer-wins rule selects a winner.
4. Receipt, event, snapshot, quarantine, tombstone, inactive-consumer, and revoked-key retention/GC rules are implementable without unstated assumptions.
5. `quarantined`, `blocked`, `stale`, and `retry_scheduled` have one exhaustive normative meaning and terminal/retry classification.
6. Every Settings command is absent from the v2.0 action registry and fails before receipt creation.
7. A capability cannot advertise execution enabled unless pairing, Ed25519, transport, and the signed Drive interoperability receipt are all ready.

## Required response

Return:

- conformance result from the packaged runner;
- Hermes-native fixture result;
- one row per incompatibility with severity, normative source, exact field/path, and proposed fix;
- explicit `GO` or `NO-GO` for U2 (verified immutable Drive transport);
- explicit confirmation that command execution remains disabled until the live probe below passes.

## Later cutover gate

After Hermes implements the contract, run the bidirectional signed Drive probe in `HERMES_RUNBOOK.md` with the real BattlePlan and Hermes OAuth clients. Both directions must produce the required signed receipt before enabling command writes, shadow traffic, or v1 retirement.
