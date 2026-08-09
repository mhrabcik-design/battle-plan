# BattlePlan–Hermes protocol package

Start with `API_REFERENCE.md`, then implement `SECURITY_AND_PAIRING.md`, `MESSAGE_LIFECYCLES.md`, `ERROR_REGISTRY.md`, `REVISION_AND_RETENTION.md`, `POLICY.md`, `VERSIONING.md`, and `HERMES_RUNBOOK.md` in that order.

U1 is approved at producer commit `daafb7e80d410bd717663a143e4c73cbafa15bb7`. For U2, implement the source-independent immutable adapter from `DRIVE_TRANSPORT.md`; the live bidirectional authorization gate remains in `HERMES_RUNBOOK.md`.

Schemas are JSON Schema Draft 2020-12. `ARTIFACT_MANIFEST.json` is the generated, non-circular checksum of their exact bytes; this includes `schemas/temporal-profile.schema.json`, which is the only normative date/time acceptance definition. `fixtures/valid` and `fixtures/invalid` are the source-independent conformance corpus. The nine signed families include the control-plane `drive-receipt`; a capability links a passed receipt by exact message ID and canonical signed-body digest. BattlePlan's focused gate is:

```sh
cd battle-plan
npm run test:agent-protocol
```

Contract-ready does not mean cutover-ready. A signed live Drive interoperability receipt and Hermes-side fixture pass remain mandatory before command execution.
