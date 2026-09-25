---
title: Durable task changes need both local fencing and remote preconditions
date: 2026-09-20
last_updated: 2026-09-25
category: architecture-patterns
module: Agent Collaboration Protocol
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "A locally committed task change must eventually reach Google Calendar"
  - "A request can remain in flight after another browser worker recovers its lease"
tags: [agent-protocol, indexeddb, outbox, fencing, concurrency, google-calendar]
---

# Durable task changes need both local fencing and remote preconditions

## Context

The historic Hermes U4 branch proposed an atomic task mutation service and Google
outbox. Applying that branch unchanged would discard newer editor, suggestion
identity, schedule-undo and Drive-merge guarantees. Its local lease alone also
could not prevent an already-issued HTTP request from overwriting a newer remote
edit. The September integration adapts those ideas to the current callers.

## Guidance

Keep three separate boundaries:

1. **Local commit:** read current task, validate the revision, and persist task,
   revision, safe event and effect snapshots in one Dexie transaction. Outer
   suggestion/import/schedule transactions must include `taskMutationTables`.
   Calling a correct inner service from an underspecified outer transaction does
   not make the combined operation atomic.
2. **Delivery ownership:** bind the effect to the intended Google account and
   allocate an increasing sequence per task. Pending, retrying and running
   predecessors block later effects. Never infer an old effect's destination
   from whichever account happens to be signed in after reload; explicit editing
   or Sync can bind previously unbound local work.
3. **Remote conditional write:** reserve one Calendar identity before sending a
   create. Place it in the event resource's `id`. For update/delete, GET the ETag,
   recheck ownership/account and send PATCH/DELETE with `If-Match`. Local fencing protects the
   acknowledgement; the server precondition protects a request already in flight.

The implementation is in `battle-plan/src/services/taskMutations.ts`,
`battle-plan/src/services/externalEffectOutbox.ts` and
`battle-plan/src/services/googleService.ts`.

After acknowledgement, write only pairing metadata whose reserved target still
matches. Do not write the queued task snapshot back into the task: it may already
have newer text, a newer schedule, or a deletion tombstone. Pairing metadata does
not create a new public domain revision.

## Why This Matters

An expired local lease cannot recall a network request. For example, worker A
sends a PATCH and stalls; worker B recovers the queue, repeats that same effect,
then sends the next edit. A's eventual write must fail the old ETag precondition,
and its acknowledgement must fail the local fence. Neither protection substitutes
for the other. A stable create identity separately prevents duplicate insertion
when the first response is lost.

Authentication and offline waits remain retryable. A permanent rejected effect is
retained for diagnostics but permits a corrected successor; recovery creates a
snapshot of current desired state instead of replaying an obsolete failed row.

The cached Google email is only a login hint, not proof of the current token's
account. Re-consent can return a token for another account. Verify userinfo for
each accepted token, including restored and refreshed tokens, before exposing
usable authentication. Capture the token and session generation so a late
identity response cannot restore a signed-out or replaced session. Keep the
effect's original account binding throughout this process.

Lease renewal also needs a finite execution deadline. A request that never
settles otherwise renews its lease forever and holds the scheduler open. Expire
the local attempt guard before scheduling a retry; a late response must neither
acknowledge success nor issue a follow-up write. Already-issued Calendar writes
still rely on the stable identity and ETag protection above.

An editor's status toggle must not grant a newer revision to an older draft.
Advance its revision only when the saved mutation's base revision matches the
draft's revision. Copying the latest revision while retaining old title or
schedule fields would make the later stale save appear valid.

## When to Apply

Use this boundary for local task writers and their Google effects. Google-only
items without a local task retain their direct API path. Browser shutdown pauses
delivery; this is not an always-running server queue. The signed v2 command
runtime remains disabled, and the existing timestamp-based Drive merge policy is
unchanged. Local effect ordering is not a global ordering protocol across devices.

## Examples

`battle-plan/src/services/externalEffectOutbox.test.ts` controls request completion
order through the real Google adapter with a simulated HTTP server: create/edit/
archive converge on one tombstone; an old in-flight PATCH receives 412 after a
successor updates the ETag. Mutation, suggestion and import tests inject failures
after intermediate writes to prove whole-transaction rollback. A live authenticated
Google smoke test still requires an authorized account.

## Calendar invitations and field ownership

The invitation change prepared on 2026-09-25 keeps guest entry and RSVP in Google
Calendar. BattlePlan opens the existing event after its queued public content has
been delivered; a Calendar template URL would create a second, unpaired event.

This choice changes the meaning of a sync write: the event now contains data owned
by Google and its guests. A full replacement from a local task cannot safely
represent it. PATCH only the fields BattlePlan owns, preserving attendees, response
statuses, location and conference data. Keep both local fencing and ETag checks;
PATCH alone does not protect against stale concurrent writes.

Exclude internal notes at the Google adapter boundary, not just at the invitation
button. A durable outbox can replay an older payload after this release. Public
changes and deletion notify existing attendees; reminder-only and no-op retries
must not send repeated invitations. The adapter tests exercise these boundaries.

Before inviting real guests, update all devices and reload old open app tabs.
An old client still has the former replacement behavior. This release does not
retroactively recall content previously sent by an older client. The local OAuth
origins were not registered during verification, so the user chose to perform the
authenticated invitation, reschedule and cancellation smoke test after deployment.

## Related

- [Command ledger](durable-agent-protocol-ledger.md)
- [Suggestion decision registry](durable-suggestion-decision-registry.md)
- [Google conditional requests](https://developers.google.com/workspace/calendar/api/guides/version-resources)
- [Google event insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
