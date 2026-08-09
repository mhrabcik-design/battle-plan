# Versioning and compatibility

The protocol uses `MAJOR.MINOR.PATCH`; this package implements exactly `2.0.0`.

- **Major:** incompatible wire shape, signature bytes, lifecycle meaning or action semantics. Unsupported majors quarantine before receipts.
- **Minor:** additive message family, action, error code or optional capability whose absence is safe. Both peers must advertise an overlapping range before use.
- **Patch:** documentation or validator correction that does not expand accepted data or change semantics.

All schemas reject unknown properties. A sender only emits variants advertised by the target capability. A receiver never guesses future semantics. A future minor that adds fields requires a corresponding schema and negotiated capability; silently ignoring them is prohibited.

Handshake succeeds only when the advertised inclusive `minimum`/`maximum` ranges overlap on a supported version and both sides possess the exact artifact checksum. Until then capability health is disabled. V1 and v2 files are different APIs; v2 writers never write v1. Migration is outside U1.

## Deterministic artifact checksum

`ARTIFACT_MANIFEST.json` is generated from schemas only, so it cannot include itself or fixtures whose examples advertise its hash. All normative validation that affects schema acceptance, including the complete temporal profile, must therefore be encoded in a manifest-covered schema; hidden generator callbacks are forbidden. The algorithm is:

1. Enumerate `schemas/*.schema.json`, sort ascending by the path string `schemas/<filename>`, and read raw bytes without newline normalization. Repository `.gitattributes` pins the schemas, manifest and generated validators to LF so Windows and Unix checkouts compare identical bytes.
2. For every schema record `{path,bytes,sha256}`, where `bytes` is the raw byte length and `sha256` is `sha256:` plus lowercase SHA-256 of the raw bytes.
3. Form `{format:"battleplan-hermes-contract-manifest/v1",artifact_id:"battleplan-hermes-protocol",version:"2.0.0",schemas:[...]}`.
4. RFC 8785-canonicalize that object and hash UTF-8(`BattlePlan-Hermes/artifact-manifest/v1\0` + JCS(material)). Store the prefixed result as `artifact_sha256`.
5. `hello`, `capability`, and `drive-receipt` copy `{id:artifact_id,version,sha256:artifact_sha256}` exactly. A trusted receiver compares all three fields.

`npm run agent-protocol:check` recomputes both every schema digest and the aggregate manifest. Any raw schema-byte drift fails the gate until validators and the manifest are regenerated and the advertised tuple is updated.

## Artifact release checklist

1. Update schemas and TypeScript discriminated contracts.
2. Add valid and invalid conformance fixtures.
3. Update lifecycle/error/action registries and changelog.
4. Regenerate standalone validators and `ARTIFACT_MANIFEST.json`; update advertised fixture tuples.
5. Run `npm run test:agent-protocol`; documentation drift is a failure.
6. Publish the whole `docs/agent-protocol/v2` directory atomically.

## U1 temporal-profile artifact rotation

Moving temporal acceptance from a generator callback into `schemas/temporal-profile.schema.json`, and the final UUID acceptance rule from `ajv-formats` into `envelope.schema.json`, changed the exact artifact hash from `sha256:1b927765d2a36d9bcd7fbf5048ea08b103f9202fc979718e1425413134f20a83` to `sha256:fa0496524c56796ff8eec77f5ccd013b4b6d404836d673b1cb8dcc70ae96d7d7`. This is an intentional compatibility boundary while v2 remains pre-cutover. A peer advertising the old tuple is not contract-compatible even though both envelopes say `2.0.0`; pairing/capability stays disabled until both advertise the new exact tuple.
