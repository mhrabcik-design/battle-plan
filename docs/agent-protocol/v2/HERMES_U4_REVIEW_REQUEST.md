# U4 integration into the current application

This implementation adapts the historic Hermes U4 proposal to main v4.3.73.
It is pending integration; it does not enable signed v2 command execution.
The implementation contract is [the integration plan](../../plans/2026-09-20-integrate-hermes-u4-plan.md).

## Scope and evidence

| Unit | Implemented boundary | Verification |
| --- | --- | --- |
| U1 | Atomic task, revision, safe event and ordered Google effects; schema 19 | Revision races, nested rollback, reservation stability, command fences and migrations |
| U2 | Account-bound delivery, lease renewal, FIFO per task, guarded acknowledgements | Controlled Google HTTP tests, stale PUT/ETag, auth recovery, reload and teardown |
| U3 | Editor, checklist, status, schedule/undo, voice and legacy Hermes | Existing regressions plus durable effect/revision assertions and stale-editor rejection |
| U4 | Suggestion conversion and Drive merge compose the mutation transaction | Replay, occurrence identity, local-ID collisions, timestamp winner and rollback tests |
| U5 | Direct-write audit, current backup tests, browser checks, CE review | See PR validation and review receipt |

The direct task-write audit leaves task persistence inside the mutation service,
metadata-only acknowledgement and the existing retention purge in App. Migrations
remain database maintenance. Direct Google Tasks updates remain only for external
items without a local task. Drive import does not echo downloaded tasks back into
Google. New, unlinked meetings retain the existing usable-auth opt-in rule; linked
or explicitly synchronized tasks can accumulate durable effects while offline.

## Changes from the historical proposal

Calendar creation supplies the reserved ID in the event resource. Reservation and
account binding survive edits before acknowledgement. FIFO is checked durably even
for filtered drains. Conditional PUT/DELETE plus local fencing handle late remote
requests. Calendar payloads retain completion, internal notes and total duration.
Unavailable authentication cannot count as a successful delete; recoverable errors
do not exhaust a short retry budget. Permanent failures remain visible and can be
superseded by a corrected, successful effect.

Current editor locking, occurrence conversion, Drive identity matching, guarded
schedule-only undo and view-independent backup remain in place. The editor also
advances its draft revision after an immediate status toggle without discarding
unsaved text.

## Validation and limits

At the pre-review checkpoint: all 479 tests passed, lint and TypeScript/Vite build
passed, protocol validator generation matched, and 33 conformance fixtures passed.
Build warnings about chunk size and mixed static/dynamic imports are informational.
The PR records any subsequent corrections and final counts.

Browser checks run on an isolated local origin without a Google account. The
real-account OAuth/Calendar smoke check is not covered by the simulated server.
Automatic delivery runs while the browser app is open; local queues are not a
cross-device global sequencer. Full v2 capability probing, approval UI, command
execution and event transport are outside U4.

See [the durable-effects learning](../../solutions/architecture-patterns/durable-task-mutations-and-google-effects.md)
for the rationale behind both local and remote concurrency protection.
