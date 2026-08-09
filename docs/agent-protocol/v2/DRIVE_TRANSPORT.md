# Immutable Google Drive transport profile v2

Status: normative for U2. Profile identifier: `drive-immutable-v2`.

This document defines the source-independent Google Drive adapter contract. It is sufficient to implement the same transport in Hermes without importing BattlePlan source. The signed JSON contract remains defined by the schemas and `API_REFERENCE.md`; this profile defines how those exact bytes are created, discovered, verified, retried, and consumed.

Production command execution, command writes, shadow traffic, and v1 retirement are not authorized by implementing this profile. They remain separate rollout gates.

## 1. Pinned workspace binding

The adapter receives this configuration from an explicit out-of-band pairing/bootstrap step:

| Value | Rule |
| --- | --- |
| `account_id` | Stable local discriminator for the authenticated Google account. It scopes every cached folder binding and change cursor. |
| `folder_id` | Exact immutable Drive ID. Runtime transport never creates or replaces this folder. |
| `folder_name` | Expected human-readable name. It is checked, never used alone as authority. |
| `expected_parent_id` | The folder must have exactly this sole parent. |
| `authority` | Exactly one shared-drive ID or owner permission ID. |
| `workspace_id` | Paired protocol workspace UUID. |

Before every publish or synchronization flight:

1. Load the account-and-workspace-scoped cached binding. If it exists and any field differs, stop with `stale_binding_cache`; do not overwrite it automatically.
2. List every folder page for exact `folder_name`, `expected_parent_id`, folder MIME type, and `trashed=false`. Reject `incompleteSearch`.
3. Require exactly one result and require its ID to equal `folder_id`. Zero is `workspace_missing`; any other cardinality or ID is `workspace_ambiguous`.
4. Read `folder_id` through `files.get`. Require the expected name, folder MIME type, `trashed=false`, sole parent, and authority.
5. Only after all checks pass may the binding cache be written.

Folder creation is not a runtime fallback. A missing, renamed, duplicated, moved, trashed, wrong-owner, or wrong-drive folder disables the transport until the user repeats explicit pairing/bootstrap.

## 2. One message per immutable file

Each protocol wire message occupies one Drive file. Shared JSON arrays and whole-file read-modify-write are forbidden.

- MIME type: `application/json`.
- Body: the exact UTF-8 canonical JSON wire envelope, including `signed` and `signature`.
- File name: `<message_id>.json`. The name is diagnostic only and is never a uniqueness or trust key.
- Parents: exactly `[folder_id]`.
- File ID: reserved before upload with `files.generateIds(count=1, space=drive, type=files)` and stored durably with the outbound attempt before create.
- Create: one `files.create` multipart upload with the reserved `id`; no later body update is allowed.
- Size: compare Drive's decimal `size` to the downloaded UTF-8 byte length.

Public Drive properties are non-authoritative search hints. Every property below is required and must be compared to the verified body:

| Property | Exact value |
| --- | --- |
| `bpv2_transport_profile` | `drive-immutable-v2` |
| `bpv2_protocol_major` | `2` |
| `bpv2_message_type` | authenticated `signed.message_type` |
| `bpv2_message_id` | authenticated `signed.message_id` |
| `bpv2_workspace_id` | authenticated `signed.workspace_id` |
| `bpv2_producer_id` | authenticated `signed.producer_id` |
| `bpv2_key_id` | authenticated `signed.signing_key_id` |
| `bpv2_pairing_epoch` | base-10 authenticated `signed.pairing_epoch` |
| `bpv2_content_sha256` | protocol content digest: SHA-256 of `BattlePlan-Hermes/v2\0` plus UTF-8 JCS of `signed` |
| `bpv2_body_sha256` | SHA-256 of the exact complete UTF-8 file body |

Acknowledgement properties used by the live probe may be added later. Consumers compare the required property subset and never reinterpret extra properties as signed authority.

## 3. Prepare and publish algorithm

Preparation is deterministic except for the reserved Drive ID:

1. Enforce the U1 raw JSON, canonicalization, schema, message-family, and workspace rules.
2. Reserve one Drive ID.
3. Compute `bpv2_content_sha256` from the domain-separated canonical `signed` bytes.
4. Compute `bpv2_body_sha256` from the exact complete canonical wire bytes.
5. Materialize a serializable prepared record containing file ID, exact body, both digests, filename, MIME type, sole parent, properties, and byte size.
6. Persist that record in the sender's durable outbox before upload. BattlePlan's outbox is implemented in a later milestone; Hermes must provide its own durable equivalent.

Publish the prepared record with one create call. A successful response must return the reserved ID.

If the create response is ambiguous because of timeout or returns HTTP `409`, do not allocate another ID. Fetch the reserved ID and require all of the following:

- exact ID, filename, MIME type, sole parent, `trashed=false`, byte size, and every required property;
- exact downloaded body bytes;
- recomputed exact-body SHA-256 equals the prepared digest.

Only a complete match is a successful replay. Any mismatch is `immutable_file_conflict`. Authentication, missing-object, rate-limit, and server failures retain their own classifications; they are not converted into success.

## 4. Verified read algorithm

For each candidate file ID:

1. `files.get` exact metadata and `files.get(alt=media)` exact bytes.
2. Require JSON MIME type, `trashed=false`, sole `folder_id` parent, and exact byte size.
3. Run the complete U1 verifier in normative order: raw/canonical/schema checks, trusted pairing lookup, key fingerprint, Ed25519, workspace, producer, target, artifact, and expiry.
4. Recompute both digests.
5. Compare every required public property to the authenticated body and recomputed values.
6. Only then deliver the typed message to the durable consumer callback.

The transport must not provide a structural-only production verifier. A schema-valid message with a bad signature is `verification_failed` and is never delivered.

## 5. Pagination and initial synchronization

Folder scan uses a paginated `files.list` constrained by sole parent, `trashed=false`, `bpv2_protocol_major=2`, and exact workspace property. Consume every page. Reject `incompleteSearch`. Drive result order, filename, `modifiedTime`, and change order are not domain order; event streams carry their own producer sequence.

Gap-free bootstrap is start-token-first:

1. Capture `changes.getStartPageToken` before scanning.
2. Perform the complete paginated folder scan.
3. Replay every Drive change page from the captured token through the same verified-read path.
4. Deduplicate file IDs seen in both the scan and replay within this synchronization flight.
5. Persist only the final `newStartPageToken`, and only after every delivered message has durably committed.

Normal polling loads the account/workspace cursor and consumes changes from it. A `nextPageToken` may be persisted only after every relevant file on that page has durably committed. The final `newStartPageToken` follows the same rule. A malformed, unsupported, untrusted, missing, or failed relevant file leaves the failing page unadvanced.

A removal change whose supplied metadata identifies a bound protocol file is `missing_file` and leaves the page unadvanced; immutable protocol files are never validly deleted in this profile. A removal with no protocol metadata is ignored because an account-wide owner change feed also contains unrelated Drive objects. Retention and authorized GC are defined separately and cannot masquerade as an ordinary immutable-message deletion.

Overlapping startup/focus/visibility/interval triggers in one process join one in-flight synchronization promise. Cross-tab and crash-safe application idempotency belongs to the durable receipt/ledger milestone and cannot be replaced by this optimization.

## 6. Required Google Drive requests

All applicable requests set `supportsAllDrives=true`; list/change calls set `includeItemsFromAllDrives=true`. Shared-drive bindings additionally set exact `driveId` and `corpora=drive`; owner bindings use `corpora=user`.

- `files.get(fileId, fields=id,name,mimeType,parents,trashed,owners(permissionId),driveId,properties,size)`
- `files.list(q=..., pageSize=1000, pageToken=..., fields=nextPageToken,incompleteSearch,files(...))`
- `files.generateIds(count=1, space=drive, type=files)`
- `files.create(uploadType=multipart, fields=id)` with the reserved ID
- `files.get(fileId, alt=media)`
- `changes.getStartPageToken(driveId=...)`
- `changes.list(pageToken=..., pageSize=1000, spaces=drive, fields=nextPageToken,newStartPageToken,changes(...))`

The intended OAuth scope is exactly `https://www.googleapis.com/auth/drive.file`. Do not silently widen it. Whether both production OAuth clients can see each other's created files is decided only by the signed live bidirectional probe in `HERMES_RUNBOOK.md`.

## 7. Stable transport outcomes

| Condition | Outcome | Cursor rule |
| --- | --- | --- |
| HTTP 401/403 | `authorization_failed` | Do not advance. |
| HTTP 429 | `rate_limited` | Bounded retry with the same prepared ID; do not advance. |
| HTTP 5xx | `transport_retryable` | Bounded retry with the same prepared ID; do not advance. |
| Expected file HTTP 404 | `missing_file` | Do not advance. |
| Zero paired folders | `workspace_missing` | Disable transport. |
| Duplicate/name-ID mismatch | `workspace_ambiguous` | Disable transport. |
| Wrong sole parent | `workspace_parent_mismatch` | Disable transport. |
| Wrong owner/shared drive | `workspace_authority_mismatch` | Disable transport. |
| `incompleteSearch=true` | `incomplete_search` | Do not accept the page. |
| Invalid JSON/schema/canonical bytes | `malformed_message` | Do not deliver or advance. |
| Unsupported major/family/action | `unsupported_message` | Do not deliver or advance. |
| Signature/trust/address/artifact failure | `verification_failed` | Do not deliver or advance. |
| Body/property/parent/size mismatch | `metadata_mismatch` | Do not deliver or advance. |
| `409` with non-identical existing object | `immutable_file_conflict` | Terminal for that prepared upload; never allocate a replacement ID for the same record. |

No transport outcome creates a command result receipt before command validation and durable claim. This profile performs no Task, WorkLog, Project, Settings, Calendar, or Google Tasks mutation.

## 8. Source-independent adapter checklist

An adapter is U2-conformant only if it proves all of these with fakes plus the later live probe:

- exact workspace binding, ambiguity detection, account-scoped cache, and no runtime folder creation;
- pre-generated durable ID and exact-body multipart create;
- complete `409` replay comparison;
- full list/change pagination and `incompleteSearch` rejection;
- start-token-first scan plus replay with no in-flight duplicate delivery;
- page-token persistence after durable consumer commit only;
- complete cryptographic verifier before property comparison and delivery;
- distinct auth, rate, retry, missing, malformed, unsupported, trust, and metadata failures;
- one-process single-flight for overlapping poll triggers;
- no command execution, shadow traffic, or v1 cutover side effect.

## 9. Google API reference basis

The request parameters and retry model above are pinned to the official Drive API v3 references:

- [Generate IDs and documented `409 Conflict` replay](https://developers.google.com/workspace/drive/api/guides/create-file#generate_ids_to_use_with_your_files)
- [`files.create`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)
- [`files.list` pagination and `incompleteSearch`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [`changes.getStartPageToken`](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken)
- [`changes.list` tokens and shared-drive parameters](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list)
- [Public custom file properties and limits](https://developers.google.com/workspace/drive/api/guides/properties)
