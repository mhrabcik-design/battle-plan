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
BattlePlan-Hermes v2 source-independent schema conformance: 31 fixtures passed.
```

Hermes must also validate every fixture with its own implementation. It must not import BattlePlan TypeScript as its protocol implementation.

## Required review decisions

Confirm or reject each item with an exact file, JSON path or field, observed behavior, and proposed correction:

1. BattlePlan and Hermes own separate Ed25519 keypairs. A required trusted pairing record carries the exact raw public key and its recomputed SHA-256 fingerprint plus key ID, pairing epoch, producer, target and workspace. Verify with that raw key and require both hello assertions to match; there is no self-authorizing or default-active path.
2. Ed25519 and SHA-256 use the same domain-separated UTF-8 bytes of the RFC 8785 canonical `signed` body. Drive properties are non-authoritative hints.
3. Entity revisions are content-addressed. Concurrent heads create an explicit deterministic conflict set; a conflicted snapshot carries every full revision/projection/tombstone and recomputes all revision and set IDs. No timestamp, Drive order, producer name, or last-writer-wins rule selects a winner.
4. Receipt, event, snapshot, quarantine, tombstone, inactive-consumer, and revoked-key retention/GC rules are implementable without unstated assumptions.
5. `result.schema.json` exhaustively constrains every lifecycle/error/effect combination. `crypto_unsupported`, contract-artifact mismatch and Drive bootstrap failures disable the control plane and never appear in a command result.
6. Every Settings command is absent from the v2.0 action registry and fails before receipt creation.
7. `ARTIFACT_MANIFEST.json` recomputes from sorted raw schema bytes without circular fixture input, and hello/capability/drive-receipt advertise its exact tuple.
8. The ninth signed `drive-receipt` family losslessly records both OAuth probe directions and all required IDs/outcomes/verdicts. A capability `passed` reference is accepted only when the receipt message ID, content digest, completion time, workspace and contract artifact all match.
9. A capability cannot advertise execution enabled unless pairing, Ed25519, transport, and the signed Drive interoperability receipt are all ready.
10. RFC 3339 timestamps accept numeric offsets, reject impossible Gregorian dates, and preserve the original signed string.
11. Capability-to-receipt link verification cryptographically verifies both messages with their respective trusted pairing records before comparing authenticated link fields; fixture signatures such as `AA` can never pass this helper.
12. Current/superseded Drive receipts, both linked probe hello files, and inactive-consumer records have explicit clock start points, minimum durations and fail-closed GC conditions.

## Required response

Return:

- conformance result from the packaged runner;
- Hermes-native fixture result;
- one row per incompatibility with severity, normative source, exact field/path, and proposed fix;
- explicit `GO` or `NO-GO` for U2 (verified immutable Drive transport);
- explicit confirmation that command execution remains disabled until the live probe below passes.

## Later cutover gate

After Hermes implements the contract, run the bidirectional signed Drive probe in `HERMES_RUNBOOK.md` with the real BattlePlan and Hermes OAuth clients. Both directions must produce the required signed receipt before enabling command writes, shadow traffic, or v1 retirement.
