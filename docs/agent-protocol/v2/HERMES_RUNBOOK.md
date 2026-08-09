# Hermes integration runbook

This guide is sufficient to implement the Hermes adapter without BattlePlan source. Do not enable command writes until all contract checks and the live Drive receipt pass.

## 1. Consume the contract

Vendor the complete `docs/agent-protocol/v2` directory. Validate JSON with Draft 2020-12 schemas, reject unknown properties, implement RFC 8785 JCS with the additional `-0`, duplicate-key, unsafe-integer and Unicode guards, and load the exact error/action/lifecycle registries. Independently recompute `ARTIFACT_MANIFEST.json` exactly as specified by `VERSIONING.md`; pin its artifact tuple in the local trusted configuration. Run every fixture through Hermes's own validator and compare the declared result.

## 2. Create the Hermes identity

Run the Ed25519 capability probe in a secure context. Create a Hermes-owned non-exportable private key and export only the raw public key. Assign a stable producer ID, key ID and pairing epoch. Show the base64url SHA-256 public-key fingerprint to the user. Exchange and verify the BattlePlan public key/fingerprint through a channel outside Drive. Never put a private key or pairing secret in Drive.

## 3. Pair without enabling execution

Pin the workspace UUID, exact Drive folder ID, expected parent/shared-drive identity, both producer identities, exact target IDs, both active raw 32-byte public keys, computed fingerprints, key IDs and epochs. Exchange signed `hello` messages. Import only the trusted-record raw key; recompute its fingerprint and require both hello key assertions to match. A hello cannot self-authorize. BattlePlan advertises `execution_enabled=false` until the probe below succeeds.

## 4. Repeatable bidirectional Drive interoperability probe

Use the actual production OAuth client IDs and intended `drive.file` onboarding. Never silently widen OAuth scopes. Record every HTTP status, Drive file ID, folder ID, parent, owner/shared-drive identity, MIME type, protocol properties, content digest and verifier result in a signed local receipt.

For direction A (`battleplan_to_hermes`) and then direction B (`hermes_to_battleplan`):

1. Resolve the already pinned folder by exact ID with `files.get(fields=id,name,mimeType,parents,owners,driveId,trashed,capabilities)` and `supportsAllDrives=true`. Reject missing, trashed, unexpected parent/drive/owner, or multiple same-name candidates. Never select by name.
2. Creator obtains a file ID with `files.generateIds(count=1,space=drive)` when supported, then uploads one canonical signed `hello` with `purpose=drive_interop_probe`, the exact `probe_id`, direction, folder IDs and creator client. MIME type is `application/json`; the sole parent is the pinned folder.
3. Creator stores only index hints in public properties: protocol major, message type, message ID, workspace ID, producer ID, key ID, pairing epoch, probe ID and SHA-256 digest. No property is trusted until it matches the verified body.
4. Consumer uses a paginated `files.list` constrained by exact parent, `trashed=false` and probe property; it must find exactly one ID. Empty is authorization failure; more than one is ambiguity.
5. Consumer calls `files.get` for metadata and `files.get(alt=media)` for bytes, verifies parent/MIME/properties, canonical JSON, digest, Ed25519 signature, workspace, producer and target.
6. Consumer updates a non-authoritative acknowledgement property on the same file and downloads it again. Creator observes the exact file ID and acknowledgement without accepting changed body bytes.
7. Consumer publishes the reverse-direction signed probe using its own OAuth client and Ed25519 key. Repeat steps 1–6.
8. Publish the ninth family, signed `drive-receipt`, only if both directions passed. It contains the exact contract artifact, `drive.file` scope, pinned folder/parent and owner-or-shared-drive authority, completion time, and exactly two ordered direction records. Each record preserves immutable probe/hello/file IDs, creator client, body digest, signing key, `create/list/get/download/acknowledge/reread` outcomes with the same observed file ID, and body/signature/properties/parent verdicts. Partial or failed probes cannot produce a passed receipt.
9. Capability may report `drive_interop_probe.status=passed` only when it copies that receipt's authenticated message ID, canonical signed-body content digest and exact completion time. Revalidate both messages, workspace and contract artifact when following the link; mismatch is `drive_receipt_mismatch`.

Required stop mappings:

- HTTP 401/403 or counterpart file invisible → `drive_authorization_failed`.
- Same-name folder ambiguity, owner/account mismatch or more than one probe → `drive_workspace_ambiguous`.
- Wrong/missing parent or shared-drive identity → `drive_parent_mismatch`.
- Transient 429/5xx before any mutation → `transport_retryable` with bounded backoff and the same probe ID.

Any stop leaves `execution_enabled=false`. These are control-plane failures and create no command `result` receipt. The runtime does not fall back to another folder, broaden scope, enable unsigned mode, or create production commands.

## 5. Operational message loop (after cutover approval only)

Canonicalize, sign and upload one immutable message per file. Target one advertised receiver. On ambiguity retry the identical canonical bytes and ID. Persist results/events before advancing a cursor. On a sequence gap, stop canonical application and load a signed snapshot. On concurrent entity heads, retain both and wait for `conflict_resolved`. Proposals remain non-executable.

## 6. Rotation and recovery

Follow `SECURITY_AND_PAIRING.md`. A revoked/unknown epoch quarantines. A consumer inactive for 90 days must discard its incremental assumption and resnapshot. Retrying a terminal command is read-only reconciliation; it never creates a new intent.
