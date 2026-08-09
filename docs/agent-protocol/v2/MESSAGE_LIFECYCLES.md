# Normative message lifecycle

The following registry is exhaustive for command/result lifecycle values.

| State | Meaning | Receipt | Terminal |
| --- | --- | --- | --- |
| `received` <!-- result-state:received --> | Valid, authenticated, addressed command has a durable claim. | yes | no |
| `awaiting_approval` <!-- result-state:awaiting_approval --> | Current preview and approval digest are waiting for a human. | yes | no |
| `retry_scheduled` <!-- result-state:retry_scheduled --> | A transient pre-mutation operation retries with the same message ID. | yes | no |
| `applied` <!-- result-state:applied --> | Domain mutation committed once. External effects are separate entries. | yes | yes |
| `rejected` <!-- result-state:rejected --> | Valid intent failed a terminal domain rule. | yes | yes |
| `expired` <!-- result-state:expired --> | Authenticated message passed its `expires_at` or idempotency horizon. | yes | yes |
| `blocked` <!-- result-state:blocked --> | Valid and authenticated, but policy or receiver capability forbids execution. | yes | yes |
| `stale` <!-- result-state:stale --> | Expected revision or approval digest no longer matches. A new intent is required. | yes | yes |
| `quarantined` <!-- result-state:quarantined --> | Trust, schema or addressing failed before a receipt. Diagnostic only. | no | yes |

## Allowed transitions

- Ingress → `quarantined` is the only path for malformed, untrusted, unsupported-major, wrong-workspace, wrong-producer, wrong-target, revoked-key or invalid-signature input. No cursor or receipt advances.
- Ingress → `received` occurs only after complete trust and address validation.
- `received` → `awaiting_approval`, `retry_scheduled`, `applied`, `rejected`, `expired`, `blocked`, or `stale`.
- `awaiting_approval` → `applied`, `rejected`, `expired`, or `stale` after revalidation.
- `retry_scheduled` → `received`, `expired`, or `blocked`, using the same message ID and canonical digest.
- Terminal states never transition. A changed payload is always a new message ID.

`retry_scheduled` never represents work after a local domain mutation committed. Once committed, the command is `applied`; Drive publication, Calendar and Google Tasks retry independently in `effects[]` and can never reopen or duplicate the command.

## Idempotency

The key is `(workspace_id, message_id)` plus SHA-256 of the domain-separated canonical signed bytes. Same ID and digest returns the recorded lifecycle. Same ID with another digest terminates as `idempotency_conflict`. Commands older than 400 days terminate as `idempotency_horizon_expired`; producers must never reuse IDs.
