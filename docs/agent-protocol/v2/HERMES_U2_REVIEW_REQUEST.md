# Hermes U2 immutable Drive transport review request

Review exactly this BattlePlan producer commit:

`9c1d9c6de696b998ca181695493a7b845f67f1d5`

Branch: `codex/hermes-collaboration-protocol`

U1 trust/schema baseline remains the approved commit `daafb7e80d410bd717663a143e4c73cbafa15bb7` with artifact tuple:

`battleplan-hermes-protocol / 2.0.0 / sha256:fa0496524c56796ff8eec77f5ccd013b4b6d404836d673b1cb8dcc70ae96d7d7`

The U2 implementation must not change that signed JSON artifact. It adds the source-independent Google Drive transport profile `drive-immutable-v2` around the existing exact wire bytes.

## Start here

1. Checkout the exact producer commit and verify `git rev-parse HEAD`.
2. Read `DRIVE_TRANSPORT.md` completely.
3. Re-read the operational constraints in `HERMES_RUNBOOK.md` and the transport link in `API_REFERENCE.md`.
4. Inspect the source-independent boundary and reference implementation:
   - `battle-plan/src/services/agentProtocol/driveTransport.ts`
   - `battle-plan/src/services/agentProtocol/driveTransport.test.ts`
   - `battle-plan/src/services/driveJsonStore.ts` (`GapiDriveProtocolApi` only; legacy `DriveJsonStore` remains v1)
5. Confirm that no new code path starts polling, writes commands, executes commands, enables shadow traffic, or retires v1.

## Producer evidence to reproduce

From `battle-plan/`:

```text
npm test                                      # 221/221
npm run test:agent-protocol                   # 20/20 + 32/32 public fixtures
node --experimental-strip-types --test src/services/agentProtocol/driveTransport.test.ts  # 14/14
npm run lint                                  # PASS
npm run build                                 # PASS
git diff --check                              # PASS
```

Also independently confirm:

- `ajv-formats` is absent from `package.json`, `package-lock.json`, runtime source, and generator source;
- `ARTIFACT_MANIFEST.json` still recomputes to the approved U1 hash;
- generated application/public validators remain byte-identical;
- all public property names and stable U2 outcomes in code appear in `DRIVE_TRANSPORT.md`.

## Required source-independent Hermes adapter behavior

Implement the `DriveProtocolApi` operations using Hermes's own Google client and durable storage. Do not import BattlePlan application source into Hermes. The adapter must preserve:

- exact account/workspace/folder/parent/owner-or-shared-drive binding;
- every page of folder/message/change results and rejection of `incompleteSearch`;
- one pre-generated Drive ID durably associated with one exact canonical body;
- exact multipart body bytes and all ten required `bpv2_*` public properties;
- complete `409` existing-object verification before replay success;
- complete U1 cryptographic verification before property comparison or delivery;
- start-token-first bootstrap scan plus change replay;
- cursor persistence only after the durable consumer commit;
- one-process single-flight for overlapping poll triggers;
- distinct auth, rate, server, missing, malformed, unsupported, trust, metadata, and immutable-conflict outcomes.

Hermes may use different language-level interfaces, names, and storage libraries. Wire bytes, Drive queries/metadata, state transitions, cursor safety, and error meaning must remain equivalent.

## Adversarial probes required

Provide reproducible source-independent probes and machine-readable results for at least these cases:

1. Same-name folder candidates split over two pages result in `workspace_ambiguous`.
2. A cache record from another Google account results in `stale_binding_cache` and is not overwritten.
3. A prepared record whose body, digest, parent, property, size, or file ID was modified is rejected before create.
4. An ambiguous create followed by `409` succeeds only for exact metadata and exact body bytes.
5. Message scan consumes all pages and rejects `incompleteSearch=true`.
6. A file created after the start token but during the full scan is delivered once through scan/replay deduplication.
7. Verification failure and durable-consumer failure each leave the failing change page unadvanced.
8. A relevant immutable-message tombstone is `missing_file` and is not checkpointed.
9. Two overlapping poll triggers execute one change-page flight and deliver once.
10. HTTP 401/403, 404, 429, and 5xx remain independently classified.
11. A schema-valid but cryptographically invalid message is never delivered by a structural-only shortcut.
12. Drive result order and filenames are never used as protocol event order or uniqueness authority.

## Required verdict

Return both decisions separately:

1. `U2 PRODUCER GO` or `U2 PRODUCER NO-GO` for BattlePlan commit `9c1d9c6de696b998ca181695493a7b845f67f1d5` and profile `drive-immutable-v2`.
2. `HERMES U2 ADAPTER READY` or `HERMES U2 ADAPTER NOT READY`, naming the exact Hermes commit and its independent evidence.

If both are ready, explicitly state whether BattlePlan may begin U3 durable receipt/outbox work. Report every blocker with severity, exact reproduction, expected behavior, observed behavior, and affected file/line or public rule.

## Gates that remain closed

Regardless of local/source-independent results:

- production command execution: disabled;
- production command writes: disabled;
- shadow traffic: disabled;
- v1 retirement: disabled;
- live interoperability receipt: not yet passed.

The actual bidirectional signed Drive probe must still run later with both production OAuth client IDs and exactly `https://www.googleapis.com/auth/drive.file`. BattlePlan's current broad Drive token exists only for the still-running legacy v1 integration and is not evidence that the v2 probe passed.
