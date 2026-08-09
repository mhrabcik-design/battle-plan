# BattlePlan–Hermes protocol package

Start with `API_REFERENCE.md`, then implement `SECURITY_AND_PAIRING.md`, `MESSAGE_LIFECYCLES.md`, `ERROR_REGISTRY.md`, `REVISION_AND_RETENTION.md`, `POLICY.md`, `VERSIONING.md`, and `HERMES_RUNBOOK.md` in that order.

For the current U1 integration gate, follow `HERMES_REVIEW_REQUEST.md` and return its required evidence before U2 begins.

Schemas are JSON Schema Draft 2020-12. `fixtures/valid` and `fixtures/invalid` are the source-independent conformance corpus. BattlePlan's focused gate is:

```sh
cd battle-plan
npm run test:agent-protocol
```

Contract-ready does not mean cutover-ready. A signed live Drive interoperability receipt and Hermes-side fixture pass remain mandatory before command execution.
