# Versioning and compatibility

The protocol uses `MAJOR.MINOR.PATCH`; this package implements exactly `2.0.0`.

- **Major:** incompatible wire shape, signature bytes, lifecycle meaning or action semantics. Unsupported majors quarantine before receipts.
- **Minor:** additive message family, action, error code or optional capability whose absence is safe. Both peers must advertise an overlapping range before use.
- **Patch:** documentation or validator correction that does not expand accepted data or change semantics.

All schemas reject unknown properties. A sender only emits variants advertised by the target capability. A receiver never guesses future semantics. A future minor that adds fields requires a corresponding schema and negotiated capability; silently ignoring them is prohibited.

Handshake succeeds only when the advertised inclusive `minimum`/`maximum` ranges overlap on a supported version and both sides possess the exact artifact checksum. Until then capability health is disabled. V1 and v2 files are different APIs; v2 writers never write v1. Migration is outside U1.

## Artifact release checklist

1. Update schemas and TypeScript discriminated contracts.
2. Add valid and invalid conformance fixtures.
3. Update lifecycle/error/action registries and changelog.
4. Regenerate standalone validators.
5. Run `npm run test:agent-protocol`; documentation drift is a failure.
6. Publish the whole `docs/agent-protocol/v2` directory atomically.
