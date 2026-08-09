# Source-independent conformance

The package includes generated CSP-safe ESM validators with no BattlePlan imports and a fixture runner. A Hermes implementer can copy this directory and run:

```sh
npm test
```

The runner currently requires 32 fixture assertions across all nine message families, additional lifecycle/conflict variants, numeric-offset RFC 3339-profile input, impossible-calendar-date rejection, and fail-closed rejection of unsupported `:60` leap-second wire values. Fixtures marked `validation_layer: "semantic"` must pass JSON Schema and then fail the deterministic semantic checks (for example sorted/recomputed conflict revisions). Hermes must additionally run the same fixtures through its own native validator and stable error mapping, recompute `ARTIFACT_MANIFEST.json`, then implement the Ed25519/JCS tests in `THREAT_MODEL.md`. Passing local fixtures establishes contract compatibility; only the live bidirectional `drive-receipt` in `HERMES_RUNBOOK.md` establishes cutover compatibility.
