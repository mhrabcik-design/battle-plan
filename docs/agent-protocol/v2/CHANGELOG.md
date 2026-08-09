# Changelog

## 2.0.0 — 2026-08-09

- Initial normative nine-family API, including the passed-only signed `drive-receipt` control family.
- Separate Ed25519 identities with key IDs, epochs, fingerprints, rotation and revocation.
- Required trusted raw public-key records with recomputed SHA-256 binding; hello keys never self-authorize.
- RFC 8785 canonical wire/signature/digest representation.
- Generated non-circular schema artifact manifest advertised by control messages.
- Exhaustive result/error/effect combinations and explicit control-plane-disabled failures.
- Lossless resolved/conflicted snapshot variants with semantic revision and conflict-set verification.
- Exact lifecycle, error, revision/conflict, retention and policy registries.
- Settings commands intentionally forbidden for v2.0.
- Bidirectional production-OAuth Drive probe specified as a cutover gate.
