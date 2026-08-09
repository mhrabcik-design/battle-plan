# U1 threat model and conformance obligations

| Threat | Required control | Conformance proof |
| --- | --- | --- |
| Drive user forges public properties | Properties are hints; verify JCS body, digest, Ed25519, workspace, producer and target. | property/body mismatch quarantines |
| Shared HMAC compromise impersonates both peers | Separate Hermes and BattlePlan Ed25519 keypairs; no shared secret. | signature with other key fails |
| Hello substitutes an attacker key/fingerprint | Verify with required trusted raw key, recompute its SHA-256, then match both hello assertions. | raw-key or stored/asserted fingerprint mismatch quarantines |
| Peers silently validate different schemas | Generated non-circular schema manifest is required in every control message. | aggregate artifact mismatch disables control plane |
| Private key leaks through sync/backup | Non-exportable private key in owner secret store; forbidden protocol fields. | secret-shaped extra field fails schema |
| Body modified after signing | Domain-separated Ed25519 over JCS(`signed`). | one-byte body change fails |
| Duplicate-key parser disagreement | Parse raw bytes while rejecting duplicate keys before JSON object creation. | duplicate-key raw input returns `duplicate_json_key` |
| `-0`, NaN or unsafe integer ambiguity | Reject `-0`, non-finite values and unsafe integer numbers; large counters are decimal strings. | boundary fixtures fail closed |
| Replay or ID substitution | Stable message ID + canonical digest receipt, 400-day horizon. | same ID/digest reconciles; different digest rejects |
| Key rollback after rotation | Monotonic pairing epoch and 400-day revocation history. | older/revoked epoch quarantines |
| Wrong workspace/receiver | Verify authenticated body identities after signature. | workspace/producer/target mismatch quarantines |
| Future schema interpreted optimistically | Exact major/range negotiation and unknown-property rejection. | future major/unknown action inert |
| Settings or secret mutation | No Settings action variant in schema/registry; unknown action before receipt. | `settings-command.json` returns `unknown_action` |
| Multi-device last-writer-wins data loss | Content-addressed revision heads; explicit conflict set; no clock ordering. | sibling heads pause until `conflict_resolved` |
| Snapshot drops one concurrent version | Conflicted variant carries every full revision, projection and tombstone; recompute each revision and conflict set. | wrong order, revision or set ID fails schema semantics |
| Premature event GC creates cursor gap | 90-day floor plus every active checkpoint and retained snapshot coverage. | GC boundary constants and resnapshot rule |
| `drive.file` cross-client isolation | Exact two-direction live probe using actual OAuth clients and ninth signed `drive-receipt` family. | receipt captures all six outcomes per immutable file and capability links its ID/digest |
| Same-name folder capture | Pin exact folder ID, parent/drive/owner; never select by name. | ambiguity returns bootstrap stop |

U1 contains validators and contract artifacts only. It deliberately exposes no mutation handler, background poller or automatic execution switch.
