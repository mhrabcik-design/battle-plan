# BattlePlan–Hermes protocol v2.0 API reference

Status: normative, contract-ready. Cutover is disabled until the live Drive interoperability receipt described in `HERMES_RUNBOOK.md` exists.

## Normative precedence

The JSON Schemas in `schemas/`, the registries in this package, and fixtures in `fixtures/` are the public API. TypeScript is an implementation binding. Prose explains the artifacts but never overrides them. Unknown properties are rejected. All protocol files are UTF-8 JSON, at most 524,288 bytes, and use the wire shape below.

```json
{"signature":{"alg":"Ed25519","key_id":"ed25519:hermes-1","pairing_epoch":1,"value":"BASE64URL_SIGNATURE"},"signed":{"...":"authoritative message body"}}
```

The serialized file is RFC 8785 JCS. The signed and digested bytes are exactly UTF-8(`BattlePlan-Hermes/v2\0` + JCS(`signed`)). Duplicate keys, `-0`, non-finite numbers, lone Unicode surrogates and integers outside JavaScript's safe range are invalid. Large counters are canonical decimal strings.

## Envelope fields

| Field | Required semantics |
| --- | --- |
| `protocol_version` | Exact `2.0.0` in this package. Another major is quarantined. |
| `message_type` | One of the eight registered families below. |
| `message_id` | Globally unique UUID. A producer never reuses it. |
| `workspace_id` | Paired workspace UUID; checked after signature verification. |
| `producer_id` | Paired writer identity bound to the supplied public key. |
| `target` | Explicit `{kind,id}`. Commands target one receiver; streams target a named stream. |
| `created_at`, `expires_at` | RFC 3339 date-time. Commands require `expires_at`. |
| `correlation_id`, `causation_id` | UUID or `null`; results correlate to their command. |
| `signing_key_id`, `pairing_epoch` | Authoritative key identity. Must exactly match `signature`. |
| `payload` | Family-specific object. Unknown fields are rejected. |

Drive public properties are non-authoritative index hints only. If present, `message_id`, `message_type`, `workspace_id`, `producer_id`, `key_id`, `pairing_epoch`, and SHA-256 digest must match the verified body and detached signature.

## Message families and executable examples

- `hello`: pairing or bidirectional Drive probe; receiver target. <!-- fixture:fixtures/valid/hello.json -->
- `capability`: signed receiver capability and health heartbeat; stream target. <!-- fixture:fixtures/valid/capability.json -->
- `command`: targeted executable intent. Settings are not supported in v2.0. <!-- fixture:fixtures/valid/command.json -->
- `result`: command lifecycle and independent external-effect status. <!-- fixture:fixtures/valid/result.json -->
- `event-batch`: ordered producer-local events; sequence values are decimal strings. <!-- fixture:fixtures/valid/event-batch.json -->
- `snapshot`: safe state at an explicit stream high-water mark. <!-- fixture:fixtures/valid/snapshot.json -->
- `proposal`: non-executable human discussion. <!-- fixture:fixtures/valid/proposal.json -->
- `response`: human proposal decision. <!-- fixture:fixtures/valid/response.json -->

Every referenced example is loaded and validated by `validation.test.ts` with the same standalone validators used by BattlePlan. Invalid examples declare `expected_error` and a `message` to test.

## Control plane

`hello` and `capability` are control-plane messages. A valid signed hello proves identity but does not enable execution. Capability health must report `paired=true`, `ed25519_supported=true`, `transport=ready`, `drive_interop_probe.status=passed`, and `execution_enabled=true` before a sender may target commands. The receiver remains disabled on ambiguity.

## Data plane

`command`, `result`, `event-batch`, `snapshot`, `proposal`, and `response` are data-plane families. Commands and proposals are intentionally separate: a proposal never grants mutation authority. Each command action has an exact payload variant in `command.schema.json`; Settings, secrets, OAuth, pairing and bulk destructive operations have no schema variant.

## Validation order

1. Enforce byte limit and parse raw JSON while rejecting duplicate keys.
2. Enforce RFC 8785 wire representation and numeric/Unicode safety.
3. Select supported major, message family and command action.
4. Run the generated strict JSON Schema 2020-12 validator.
5. Require matching key ID and pairing epoch in body and signature.
6. Verify Ed25519 over domain-separated canonical signed bytes.
7. Verify active key epoch, workspace, producer, target and expiry.
8. Only then create a receipt or consult policy. U1 implements no mutation handler.

See `MESSAGE_LIFECYCLES.md`, `ERROR_REGISTRY.md`, `SECURITY_AND_PAIRING.md`, `REVISION_AND_RETENTION.md`, `POLICY.md`, and `VERSIONING.md` for the remaining normative rules.
