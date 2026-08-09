# Security and pairing

## Trust model

Hermes and BattlePlan each own a distinct Ed25519 signing keypair. There is no shared signing secret. Each private key is created with WebCrypto in a secure context, non-exportable where the platform permits, stored only in the owner's protocol-secret store, and excluded from Drive, IndexedDB exports, backups, logs, diagnostics, events and fixtures. Public keys are exchanged through a user-verified channel outside Drive.

Before pairing, both runtimes run `crypto.subtle.generateKey({name:'Ed25519'}, false, ['sign','verify'])`. Failure is `crypto_unsupported`, advertises `ed25519_supported=false`, and keeps execution disabled. This is fail-closed; no HMAC or unsigned fallback exists. The required browser capability is specified by [Web Cryptography Level 2](https://www.w3.org/TR/webcrypto-2/#Ed25519).

## Pairing record

Each side stores one required trusted record containing: workspace UUID, peer producer ID, exact receiver/target ID, base64url of the raw 32-byte Ed25519 public key, `key_id`, monotonically increasing `pairing_epoch`, `sha256:` plus lowercase SHA-256 of those exact raw bytes, activation time, status, and revocation time. The user compares that fingerprint through the out-of-band channel before activation. Absence of a record is `key_unknown`; there is no optional or default-active trust mode.

Verification imports the raw public key from the trusted record, never from the incoming hello. Before import it decodes exactly 32 bytes, recomputes SHA-256, and matches the stored fingerprint. After signature and address verification, both `hello.public_key.raw_public_key` and `hello.public_key.fingerprint` must exactly match the same record and recomputed fingerprint. The signed `hello` therefore only asserts a pre-authorized key; it never authorizes its own key. Drive only transports that already-authorized assertion.

## Signing

1. Build the authoritative `signed` object.
2. Serialize it with RFC 8785 JSON Canonicalization Scheme.
3. Prefix UTF-8 bytes `BattlePlan-Hermes/v2\0`.
4. Compute SHA-256 content digest over those exact bytes.
5. Sign the same exact bytes using the sender's Ed25519 private key.
6. Store base64url signature in `signature.value`; `key_id` and `pairing_epoch` must match `signed`.
7. Serialize the complete wire object with RFC 8785 JCS.

Public Drive properties may repeat routing fields and digest for search, but they are hints. A mismatch quarantines the file. They never replace verified body fields.

## Rotation and revocation

- Rotation creates a new keypair, new key ID and `pairing_epoch = previous + 1`; it is verified out of band before activation.
- A signed rotation proposal may coordinate timing but cannot authorize the new key by itself.
- A receiver accepts exactly the active epoch plus a bounded overlap explicitly recorded for in-flight messages. It never chooses the newest Drive file.
- Compromise immediately revokes the affected key/epoch. Revoked signatures quarantine even when cryptographically correct.
- Public keys, fingerprints and revocation history remain for at least 400 days. Private keys are destroyed after the locally defined recovery window.
- Rollback to an older epoch is forbidden.

## Secret redaction

OAuth tokens, pairing material, Gemini/API keys, private keys, raw audio, private diagnostics, cookies and authorization headers are forbidden in every protocol field. Settings commands are absent from v2.0 schemas. Fixtures containing secret-looking fields must be invalid.

See `THREAT_MODEL.md` for attack handling and `HERMES_RUNBOOK.md` for the pairing/probe sequence.
