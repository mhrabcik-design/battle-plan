# Hermes U2 immutable Drive transport review request

Review exactly this BattlePlan producer commit:

`9f273f5cadcf845fa26a43e20db67317d77eedd5`

Branch: `codex/hermes-collaboration-protocol`

U1 trust/schema baseline remains the approved commit `daafb7e80d410bd717663a143e4c73cbafa15bb7` with artifact tuple:

`battleplan-hermes-protocol / 2.0.0 / sha256:fa0496524c56796ff8eec77f5ccd013b4b6d404836d673b1cb8dcc70ae96d7d7`

The U2 implementation must not change that signed JSON artifact. It adds the source-independent Google Drive transport profile `drive-immutable-v2` around the existing exact wire bytes.

This is the repair commit for the five producer P1 findings reported against `9c1d9c6de696b998ca181695493a7b845f67f1d5`. Review the repair commit itself, not only the branch head. Hermes adapter commit `4a2d7a54e4bbe70e14dee07bf33bfdde2d5e9974` remains separately `READY`; do not conflate its adapter verdict with this producer re-review.

Source review artifact: `2026-08-09_BattlePlan-Hermes-U2-review-response_Hermes.md`, SHA-256 `ab0a3e83f55e1b3ce617e1ccdaa18a8f9b8f78b328458d37fff1f3978a0e5868`.

## Claimed P1 closures to verify independently

1. **P1-A prepared identity replacement:** the complete prepared record is domain-separated and sealed as `preparedSha256`; publish recomputes the seal before Drive access. Replacing both `fileId` and `metadata.id` after persistence must fail before `files.create`.
2. **P1-B scan concurrency:** public `scanAll()` now uses the same synchronization coordinator as `bootstrap()` and `poll()`. Same-kind calls join; scan and cursor operations serialize, and the cursor-bearing operation must still execute.
3. **P1-C verifier wiring:** `ImmutableDriveTransport` accepts only the branded result of `createFullU1DriveMessageVerifier()`. The factory always runs `verifyProtocolWireMessage()` with a trusted pairing record and trusted artifact after structural parsing. A direct structural-only verifier must fail at construction.
4. **P1-D missing signature:** `signature_missing` maps to `verification_failed`, never `malformed_message`.
5. **P1-E trashed tombstone:** a relevant change carrying `trashed=true` is `missing_file` even when `removed=false`; the failing cursor page remains unadvanced.

The repair also mirrors the adapter's accepted bounded-retry hardening: at most three attempts with 500 ms then 1,000 ms backoff, the same durable prepared ID on every create attempt, exact-ID verification after an ambiguous create, and no cursor advance after exhausted change reads. The adapter's `corpora` objection remains correctly rejected: `changes.list` receives exact `driveId` when applicable and never receives `corpora`; `corpora` is limited to applicable `files.list` calls.

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
npm test                                      # 230/230
npm run test:agent-protocol                   # 20/20 + 32/32 public fixtures
node --experimental-strip-types --test src/services/agentProtocol/driveTransport.test.ts  # 23/23
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
- a persisted, domain-separated preparation seal that anchors both ID fields and every prepared byte/metadata field;
- exact multipart body bytes and all ten required `bpv2_*` public properties;
- complete `409` existing-object verification before replay success;
- complete U1 cryptographic verification before property comparison or delivery;
- start-token-first bootstrap scan plus change replay;
- cursor persistence only after the durable consumer commit;
- one-process shared coordination across `scanAll()`, `bootstrap()`, and `poll()`;
- bounded retry for 429, 5xx, and incomplete network requests without changing the prepared ID or advancing an uncommitted cursor;
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
13. Simultaneously replacing both prepared `fileId` and `metadata.id` without the matching original preparation seal is rejected before create.
14. `scanAll()` held in flight prevents an overlapping `poll()` API call; after the scan completes, that poll still consumes and checkpoints its change page.
15. A direct structural-only verifier is rejected at construction, while a schema-valid message with an invalid Ed25519 signature fails as `verification_failed` under the factory verifier.
16. A missing detached signature fails as `verification_failed` and leaves the cursor unchanged.
17. A relevant `trashed=true`, `removed=false` change fails as `missing_file` and leaves the cursor unchanged.
18. 429 then network failure then success performs exactly three create attempts with the same reserved ID and delays `[500, 1000]`.
19. An ambiguous 5xx that actually committed is resolved by exact-ID verification without a second create.
20. Three failed change-page attempts preserve the original durable cursor.

## Required verdict

Return both decisions separately:

1. `U2 PRODUCER GO` or `U2 PRODUCER NO-GO` for BattlePlan commit `9f273f5cadcf845fa26a43e20db67317d77eedd5` and profile `drive-immutable-v2`.
2. Confirm whether the already-reviewed Hermes adapter commit `4a2d7a54e4bbe70e14dee07bf33bfdde2d5e9974` remains `HERMES U2 ADAPTER READY`; report any new incompatibility separately.

If both are ready, explicitly state whether BattlePlan may begin U3 durable receipt/outbox work. Report every blocker with severity, exact reproduction, expected behavior, observed behavior, and affected file/line or public rule.

## Gates that remain closed

Regardless of local/source-independent results:

- production command execution: disabled;
- production command writes: disabled;
- shadow traffic: disabled;
- v1 retirement: disabled;
- live interoperability receipt: not yet passed.

The actual bidirectional signed Drive probe must still run later with both production OAuth client IDs and exactly `https://www.googleapis.com/auth/drive.file`. BattlePlan's current broad Drive token exists only for the still-running legacy v1 integration and is not evidence that the v2 probe passed.
