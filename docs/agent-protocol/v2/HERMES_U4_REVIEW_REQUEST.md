# Hermes U4 Task mutation and external-effect review request

Review exactly the BattlePlan commit supplied with this request on branch
`codex/hermes-u4-task-mutations`. Before reading the implementation, run
`git rev-parse HEAD` and require it to equal that supplied commit.

U1 contract identity remains:

`battleplan-hermes-protocol / 2.0.0 / sha256:fa0496524c56796ff8eec77f5ccd013b4b6d404836d673b1cb8dcc70ae96d7d7`

U2 producer baseline is `edf0212e4a52ff4d51339a58b1493bb541b9f4d0`.
Hermes adapter `4a2d7a54e4bbe70e14dee07bf33bfdde2d5e9974`
remains a separate reviewed artifact. U3 was merged through PR #32; this U4
commit adds the first shared Task mutation and Google-effect boundary on top of
that durable ledger.

## Scope and claimed invariants

1. UI, voice/semantic editing, Suggestions conversion, Drive import, and the
   legacy Agent Bridge route active local Task writes through
   `TaskMutationService`. Settings remain outside protocol v2.
2. A Task mutation, content-addressed revision, safe event projection, event
   stream sequence, event outbox row, and requested external effects commit in
   one IndexedDB transaction.
3. A claimed protocol command uses `AgentProtocolLedger.commitFencedMutation()`
   so Task, receipt lifecycle, result, event, outbox, and effect records share
   one fenced transaction.
4. Expected-revision mismatch is terminal `stale` and produces no Task/event
   mutation. A lost or expired fence cannot commit domain state.
5. Protocol projections exclude local numeric IDs, internal notes,
   `agent_write_id`, Google/OAuth credentials, pairing material, and other
   Settings values.
6. Calendar and Google Tasks network calls occur only after the local commit.
   Their durable effect rows use leases and fencing, retain the original
   idempotent request, retry at most three times with bounded backoff, and are
   reclaimable after a crash.
7. Calendar upsert uses one reserved Google event ID for every retry. A
   successful worker records external metadata and terminal effect progress in
   the same local transaction.
8. Every caller-owned mutation input is deep-snapshotted synchronously before
   the first `await`, including command claims and effect requests.
9. A concurrent effect worker may update `googleEventId`, `googleId`, or
   `googleListId` without a stale whole-row Task mutation erasing that metadata.
10. Authentication availability gates immediate effect execution, not durable
    persistence for an already-linked external resource. Such an effect remains
    pending and drains after authentication recovers.
11. Runtime draining is enabled only when BattlePlan has usable Google auth.
    Protocol command execution and command writes are still not runtime-wired.

## Start here

Read these files completely:

- `battle-plan/src/services/taskMutations.ts`
- `battle-plan/src/services/taskMutations.test.ts`
- `battle-plan/src/services/externalEffectOutbox.ts`
- `battle-plan/src/services/externalEffectOutbox.test.ts`
- `battle-plan/src/services/agentProtocol/ledger.ts`
- `battle-plan/src/db.ts`
- `battle-plan/src/hooks/useTaskCommands.ts`
- `battle-plan/src/hooks/useDriveSyncOrchestration.ts`
- `battle-plan/src/services/semanticEngine.ts`
- `battle-plan/src/services/agentBridge.ts`
- `battle-plan/src/App.tsx`
- `docs/solutions/architecture-patterns/durable-agent-protocol-ledger.md`

Then audit all direct Task writes with:

```sh
rg -n "db\.tasks\.(add|put|update|delete|bulkAdd|bulkPut|bulkDelete)" battle-plan/src
```

Classify every remaining occurrence. Migration backfill, physical retention GC,
the shared mutation boundary, and integration bookkeeping inside a successful
effect transaction are allowed; active user/agent/import mutation bypasses are
not.

## Producer evidence to reproduce

From `battle-plan/`:

```text
npm run test                    # 280/280
npm run lint                    # PASS
npm run build                   # PASS
npm run test:agent-protocol     # 20/20 + 32/32 public fixtures
```

From the repository root:

```text
git diff --check                # PASS
```

The build may emit the existing browserslist, chunk-size, and dynamic-import
warnings; none may be a new error.

## Required adversarial probes

Provide source-independent or black-box reproductions for each item:

1. Mutate caller-owned create/update/import/effect/claim input immediately after
   invocation while the first database read is blocked; committed state must
   use only the original snapshot.
2. Inject a failure before the transaction completes; Task, stream sequence,
   event, protocol outbox, result, and effect tables must all remain unchanged.
3. Race two mutations from the same base revision; only one may commit and the
   loser must return or finalize `stale` without an event.
4. Hold a Task mutation after it reads the row, commit a Calendar effect that
   writes `googleEventId`, then release the mutation; the external ID must remain.
5. Update and archive an already-linked Calendar Task while auth is unavailable;
   the durable upsert/delete must exist and drain after auth recovery.
6. Fail Calendar/Tasks after the domain commit, reload the database, reclaim the
   effect, and prove that only the effect repeats, never the Task mutation.
7. Let a worker's effect lease expire and reclaim it with a newer fencing token;
   the old worker must not mark success or overwrite integration metadata.
8. Retry Calendar creation through transient failures and confirm every request
   uses the same reserved Google event ID and no duplicate event is created.
9. Re-submit the same effect request while one matching effect is pending or
   running; it must converge on the existing durable effect rather than enqueue
   duplicate work.
10. Inspect every emitted Task projection and serialized protocol row for local
    numeric IDs, internal notes, `agent_write_id`, OAuth/API keys, pairing keys,
    raw diagnostics, or Settings values; any occurrence is a blocker.
11. Send expected-revision mismatch, lost-fence, and expired-fence commands and
    prove none can mutate Task state or advance the event stream.
12. Verify that Settings actions remain absent from the v2 action registry and
    are rejected before receipt creation.

## Required verdict

Return:

- exact reviewed BattlePlan SHA and branch;
- full suite, protocol suite, fixtures, lint, build, and diff-check results;
- direct-write audit results;
- one row per finding with severity, exact reproduction, expected/observed
  behavior, and affected file/line or normative rule;
- explicit `U4 PRODUCER GO` or `U4 PRODUCER NO-GO`;
- explicit statement whether U5 may begin.

Keep adapter readiness separate from the U4 producer verdict.

## Gates that remain closed

Regardless of local results:

- production command execution: disabled;
- production command writes: disabled;
- shadow traffic: disabled;
- v1 retirement: disabled;
- live bidirectional signed Drive/OAuth probe: not yet passed.

Do not enable any gate as part of review. A later rollout decision requires the
remaining milestones, runtime/concurrency/crash verification, and the live probe
with both OAuth clients.
