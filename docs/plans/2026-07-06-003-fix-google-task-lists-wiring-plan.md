---
title: Wire getTaskLists into Drive Sync Orchestration
type: fix
status: active
date: 2026-07-06
origin: agent-native audit recommendation 8 part 2 from the 2026-07-06 audit (49% overall)
---

# Wire getTaskLists into Drive Sync Orchestration

## Summary

Calls `googleService.getTaskLists()` once at the start of every Drive sync cycle and pushes the result through the existing `setGoogleTaskLists` setter that the orchestration hook already declares in its signature. Today the setter is plumbed but never invoked, so `App.tsx` renders only the `@default` task list even when the user has many lists in Google Tasks. Closes audit recommendation 8 part 2.

## Problem Frame

`useDriveSyncOrchestration` declares `setGoogleTaskLists: (lists: GoogleTaskList[]) => void` in its argument list (`useDriveSyncOrchestration.ts:17,29,247`) and `App.tsx` passes a setter that feeds `googleTaskLists` state, but no code path inside the hook ever calls `setGoogleTaskLists`. The result: the Tasks list selector rendered in `App.tsx:533-552` is always empty, and the user sees only `@default` regardless of how many lists they actually have. The setter is dead state from the function signature perspective.

The fix is small but explicit because the `setGoogleTaskLists` plumbing already exists. Wiring `googleService.getTaskLists()` into the same call site that already calls `googleService.addToCalendar` / `updateGoogleTask` keeps the Google API surface co-located and respects the 4.3.24 auth-state discipline (the lazy-fresh-token flow that `getTaskLists` participates in is the same pattern used by `getTasks`).

## Requirements

- R1. The first step of `checkSync` calls `googleService.getTaskLists()` and stores the result via `setGoogleTaskLists` before any other Drive / Tasks work runs.
- R2. `getTaskLists` is only invoked when `hasUsableAuth(googleAuth)` is true (the same gate the rest of the sync orchestration uses); the invariant matches the precedent at `useDriveSyncOrchestration.ts:144-154` and the per-call `trySilentRefresh` discipline.
- R3. If `getTaskLists` throws (401 / 403 / network failure), the failure is logged and the rest of `checkSync` continues; an empty `googleTaskLists` array remains and the user sees the `@default`-only selector fallback.
- R4. The result is only set via `setGoogleTaskLists` once per check cycle (not in a hot path that would create unnecessary renders).

## Scope Boundaries

- In scope: `useDriveSyncOrchestration.ts` — call `googleService.getTaskLists()` inside `checkSync` and pipe it to `setGoogleTaskLists`.
- Out of scope: anything that touches the `googleTaskLists` UI surface in `App.tsx` (the existing selector works once the state is populated); refetching the list whenever a task is created (not in scope — the existing 30s Drive sync cycle is the recompute trigger).

### Deferred to Follow-Up Work

- The broader `rec 10` plan addresses the cadence of the polling loop itself; this plan only touches the missing call site. Combining the two is tempting but not necessary — this plan's diff is one line.
- The `googleTaskLists` UI in `App.tsx:533-552` is intentionally not touched; a future UX iteration can group / search the list when it grows.

## Context & Research

### Relevant Code and Patterns

- `battle-plan/src/hooks/useDriveSyncOrchestration.ts:1-247` — the hook being extended. The `setGoogleTaskLists` setter is already in the signature (line 17) and the dependency array (line 247).
- `battle-plan/src/services/googleService.ts:487-510` — `getTaskLists()` returns `GoogleTaskList[]`. Implements the lazy-fresh-token flow + 403 swallows identical to `getTasks`; no behavior delta to author.
- `battle-plan/src/hooks/useAgentBridgePolling.ts:22` — `await agentBridge.init()` precedes any other bridge call. Same pattern: initialize / hydrate state before any other bridge operations.
- `battle-plan/src/App.tsx:73,317,534-552` — the consumer; populating `googleTaskLists` state lights up the selector. No UI change required here.
- `battle-plan/src/services/googleService.test.ts:201-225,229-254,257-280,490-501,911-912,1133-1144` — six existing tests already pin `getTaskLists` behavior in isolation (lazy refresh, 401 swallow, Tasks-scope 403 swallow, Tasks-scope missing). This plan reuses those assertions by calling into the same surface through the orchestration hook — no new `googleService` tests are needed.

### Institutional Learnings

- `docs/solutions/integration-issues/ensure-fresh-token-refresh-dedup-2026-07-04.md` — `getTaskLists` participates in the same `runRefresh` single-flight discipline; the existing tests confirm this at `googleService.test.ts:202-280`.
- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` — Tasks-scope 403 is swallowed by `getTaskLists` and per-call service paths return `[]` without flipping global auth; the wiring here preserves that.
- `docs/solutions/integration-issues/drive-readiness-diagnostic-states-2026-07-05.md` — three-state diagnostic mapping (ready / folder-missing / store-unavailable). A missing-in-this-cycle Google Tasks list reads as `ready` with empty content; no diagnostic state change is needed.

### External References

None — this is a one-line call site addition using the existing service surface and the existing sink.

## Key Technical Decisions

- The wiring happens in `checkSync` (the main visibilitychange / focus / interval callback), not in `init()`. Reason: `setGoogleTaskLists` is per-cycle refresh — if a new list is created, the next 30s Drive sync cycle catches it. Calling `getTaskLists` in `init()` would give a one-shot snapshot at sign-in time; calling it in `checkSync` keeps the surface coherent with the rest of the sync work.
- The call is placed before `taskDriveBackup.loadDetailed` so the user sees their list selector populated before any Tasks data shows up. Reordering is cheap and avoids a UI flicker where Tasks populate first and the list selector fills in second.
- Failures are caught by the existing `try { ... } catch` that wraps `taskDriveBackup.loadDetailed` further down; `getTaskLists` is hoisted outside that block so a slow / failed `getTaskLists` does not block the rest of the sync. A separate narrow `try { ... } catch` around the `getTaskLists` call matches the principle of scoped error handling.

## Open Questions

### Resolved During Planning

- **Where in `checkSync` does `getTaskLists` go?** Before `taskDriveBackup.loadDetailed`. The list selector is read by `App.tsx:534`, which is rendered alongside the task grid that `taskDriveBackup` populates.
- **Wrapping `setGoogleTaskLists` in a separate `try`?** Yes. The surrounding `checkSync` is a sequential flow with a single trailing `catch`; nesting `getTaskLists` inside a tighter `try` keeps the failure surface narrow.

### Deferred to Implementation

- Whether the wired call needs an opt-out (some E2E setups may want to skip the API). The hook already honors `hasUsableAuth(googleAuth)` which gates all Drive / Google API work today; adding a second opt-out is not necessary.

## Implementation Units

### U1. Wire `getTaskLists` into `checkSync`

**Goal:** Call `googleService.getTaskLists()` inside `checkSync` and pipe the result through the existing `setGoogleTaskLists` setter.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/hooks/useDriveSyncOrchestration.ts`

**Approach:**
- Read the current `checkSync`; insert a call like `setGoogleTaskLists(await googleService.getTaskLists())` at the top of the function, before `taskDriveBackup.loadDetailed`.
- Wrap the call in a narrow `try { ... } catch (e) { console.error('task list fetch failed', e); setGoogleTaskLists([]); }` so a failure leaves the state empty (R3) without taking down the rest of the sync.
- Use the existing `googleService.getTaskLists()` (already imported as part of this file's import set).

**Patterns to follow:** the existing per-step `try` discipline (`useDriveSyncOrchestration.ts:144-154`); `googleService.getTaskLists` return contract (`battle-plan/src/services/googleService.ts:487-510`).

**Test scenarios:**
- Happy path: when `hasUsableAuth(googleAuth)` is true and `getTaskLists` returns `[{ id: 'list-1', title: 'My List' }]`, `setGoogleTaskLists` is called with the same array.
- Error path: when `getTaskLists` rejects (simulated via injected throwing getter), `setGoogleTaskLists` is called with `[]`.
- Auth gate: when `hasUsableAuth(googleAuth)` is false, `getTaskLists` is not called and `setGoogleTaskLists` is not called.

**Verification:** A node:test unit verifies the wiring. The hook is not currently exported through `agentBridge.test.ts`; if it is awkward to test, a new `useDriveSyncOrchestration.test.ts` is acceptable. Implementer picks whichever matches the existing pattern.

## System-Wide Impact

- **Interaction graph:** `checkSync` is the periodic sync orchestrator. Adding one `googleService.getTaskLists()` call adds one Drive API call per `checkSync` cadence. With the existing 30s interval (the `rec 10` plan drops it to 5s) the call frequency rises; the service's own `ensureFreshToken` discipline (R2) bounds it to one refresh per cycle.
- **Error propagation:** A `getTaskLists` failure logs and falls back to `[]`; the rest of `checkSync` continues. No state outside this call is affected.
- **State lifecycle risks:** None — `setGoogleTaskLists` is a controlled setter that App.tsx wires to its own React state. The setter is idempotent for the same array.
- **API surface parity:** None beyond the existing `getTaskLists` method.
- **Integration coverage:** Visible in the running app — the `googleTaskLists` selector in `App.tsx:533-552` populates after the first sync cycle. Manual smoke test in the next release.
- **Unchanged invariants:** The four-state auth model, the `runRefresh` single-flight, the Tasks-scope 403 swallow, and the 30s-or-5s cadence surface are all preserved.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A `getTaskLists` failure propagates and breaks the rest of the sync cycle. | The narrow `try` around the call catches the error and sets `googleTaskLists` to `[]`. The rest of `checkSync` continues unaltered. |
| `getTaskLists` returns `[]` for tasks-missing-scope users, hiding the fact from the UI. | The selector's empty state already handles `[]` (it falls through to `@default`); this matches the audit-suggested fallback. |
| Recompute every cycle (5s or 30s depending on rec 10) hits the API quota faster. | `googleService.getTaskLists` short-circuits on `!googleTasksScopeAvailable` so users without the scope pay zero API calls; users with the scope pay one cached-or-live call per cycle, which is in line with how `getTasks` and `addToCalendar` already behave. |

## Documentation / Operational Notes

- The version bump follows the auto-bump workflow.
- The visible user-facing change is in the Tasks view (`App.tsx:533-552`); the operational signal is one new Drive API call per sync cycle.
- No new env vars, no new dependencies, no schema migration.

## Sources & References

- Audit origin: agent-native audit on 2026-07-06, recommendation 8 part 2 (deferred in the original plan scope boundaries)
- Plan source: `docs/plans/2026-07-06-001-feat-widen-agent-write-contract-plan.md` § Scope Boundaries (rec 8 part 2 deferred)
- Related code:
  - `battle-plan/src/hooks/useDriveSyncOrchestration.ts:1-247` (declare-and-never-call signature)
  - `battle-plan/src/services/googleService.ts:487-510` (`getTaskLists` surface)
  - `battle-plan/src/App.tsx:73,317,533-552` (consumer)
  - `battle-plan/src/services/googleService.test.ts:201-1144` (existing coverage)
