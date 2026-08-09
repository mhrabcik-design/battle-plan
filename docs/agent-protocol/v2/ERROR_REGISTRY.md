# Normative error registry

The code is stable machine data. `Retry` means retry the identical signed message ID; otherwise create a corrected new intent only where the lifecycle permits it.

| Code | Lifecycle | Retry | Meaning |
| --- | --- | --- | --- |
| `invalid_json` <!-- error-code:invalid_json --> | quarantined | no | JSON syntax invalid. |
| `duplicate_json_key` <!-- error-code:duplicate_json_key --> | quarantined | no | Raw object repeats a key. |
| `non_canonical_json` <!-- error-code:non_canonical_json --> | quarantined | no | Not RFC 8785 JCS or contains unsafe numeric/Unicode input. |
| `payload_too_large` <!-- error-code:payload_too_large --> | quarantined | no | File exceeds 524,288 bytes. |
| `schema_invalid` <!-- error-code:schema_invalid --> | quarantined | no | Family schema rejected the body. |
| `unsupported_major` <!-- error-code:unsupported_major --> | quarantined | no | Protocol major is not supported. |
| `unknown_message_type` <!-- error-code:unknown_message_type --> | quarantined | no | Message family is not registered. |
| `unknown_action` <!-- error-code:unknown_action --> | quarantined | no | Command action is absent or forbidden; includes all Settings actions. |
| `signature_missing` <!-- error-code:signature_missing --> | quarantined | no | Detached signature absent. |
| `signature_invalid` <!-- error-code:signature_invalid --> | quarantined | no | Ed25519 verification failed. |
| `signature_metadata_mismatch` <!-- error-code:signature_metadata_mismatch --> | quarantined | no | Body key ID/epoch differs from signature metadata. |
| `public_key_fingerprint_mismatch` <!-- error-code:public_key_fingerprint_mismatch --> | quarantined | no | Raw key bytes, computed SHA-256 fingerprint, hello assertion and trusted record do not all match. |
| `contract_artifact_mismatch` <!-- error-code:contract_artifact_mismatch --> | disabled (control plane) | no | Advertised schema artifact tuple differs from the locally trusted generated manifest. No command receipt exists. |
| `crypto_unsupported` <!-- error-code:crypto_unsupported --> | disabled (control plane) | no | Runtime cannot perform WebCrypto Ed25519. No command receipt exists. |
| `key_unknown` <!-- error-code:key_unknown --> | quarantined | no | Key is not paired. |
| `key_revoked` <!-- error-code:key_revoked --> | quarantined | no | Key or epoch is revoked. |
| `workspace_mismatch` <!-- error-code:workspace_mismatch --> | quarantined | no | Authenticated body names another workspace. |
| `producer_mismatch` <!-- error-code:producer_mismatch --> | quarantined | no | Key is not bound to the named producer. |
| `target_mismatch` <!-- error-code:target_mismatch --> | quarantined | no | Receiver or stream is not this target. |
| `message_expired` <!-- error-code:message_expired --> | expired | no | `expires_at` passed. |
| `policy_blocked` <!-- error-code:policy_blocked --> | blocked | no | Local policy forbids the valid action. |
| `capability_blocked` <!-- error-code:capability_blocked --> | blocked | no | Receiver did not advertise required capability. |
| `revision_stale` <!-- error-code:revision_stale --> | stale | no | Expected revision is not the current sole head. |
| `revision_conflict` <!-- error-code:revision_conflict --> | stale | no | Entity has multiple concurrent heads. |
| `approval_stale` <!-- error-code:approval_stale --> | stale | no | Approval digest no longer matches the current preview and policy inputs. |
| `idempotency_conflict` <!-- error-code:idempotency_conflict --> | rejected | no | Same message ID has another canonical digest. |
| `idempotency_horizon_expired` <!-- error-code:idempotency_horizon_expired --> | expired | no | Command is older than 400 days. |
| `drive_authorization_failed` <!-- error-code:drive_authorization_failed --> | disabled (control plane) | no | Intended OAuth client cannot access the counterpart file. No command receipt exists. |
| `drive_workspace_ambiguous` <!-- error-code:drive_workspace_ambiguous --> | disabled (control plane) | no | Workspace identity or folder selection is ambiguous. No command receipt exists. |
| `drive_parent_mismatch` <!-- error-code:drive_parent_mismatch --> | disabled (control plane) | no | Probe file is outside the pinned parent. No command receipt exists. |
| `drive_receipt_mismatch` <!-- error-code:drive_receipt_mismatch --> | disabled (control plane) | no | Capability receipt ID/digest/time/workspace/artifact does not match the exact signed receipt. |
| `transport_retryable` <!-- error-code:transport_retryable --> | retry_scheduled | yes | Transient transport failure before mutation; same ID only. |
| `external_effect_failed` <!-- error-code:external_effect_failed --> | applied effect failed | effect only | Committed command remains applied while one external effect failed independently. |

Unknown error codes are incompatible API additions and require at least a protocol minor version.
