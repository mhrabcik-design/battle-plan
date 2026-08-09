# Source-independent conformance

The package includes generated CSP-safe ESM validators with no BattlePlan imports and a fixture runner. A Hermes implementer can copy this directory and run:

```sh
npm test
```

The runner validates all eight valid message families and proves every invalid fixture is rejected. Hermes must additionally run the same fixtures through its own native validator and stable error mapping, then implement the Ed25519/JCS tests in `THREAT_MODEL.md`. Passing local fixtures establishes contract compatibility; only the live bidirectional receipt in `HERMES_RUNBOOK.md` establishes cutover compatibility.
