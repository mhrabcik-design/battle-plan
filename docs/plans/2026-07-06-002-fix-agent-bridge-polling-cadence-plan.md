---
title: Speed Up Agent Bridge Polling + React to Tab Visibility
type: fix
status: active
date: 2026-07-06
origin: agent-native audit recommendation 10 from the 2026-07-06 audit (49% overall)
---

# Speed Up Agent Bridge Polling + React to Tab Visibility

## Summary

Drops the agent bridge polling cadence from 30s to 5s and adds a `visibilitychange` / `focus` listener so writes issued by Anu while the user had the tab in the background surface within seconds of returning. The current 30s tick is too slow for the agent path: when Anu queues writes via the inbox file, the user waits up to half a minute for the in-app task list to react. Closes audit recommendation 10.

## Problem Frame

`useAgentBridgePolling` runs on a 3s initial timer and a `setInterval(checkAgentWrites, 30_000)`. When Anu issues writes via `agent-pending-writes.json` (the inbox file), the user sees the result no sooner than the next tick. In practice this means up to 30s of latency between Anu acting and the user seeing it in `db.tasks` / `db.workLogs` / `db.projects` / `db.settings`. The existing `useDriveSyncOrchestration` hook already has the pattern that this plan adopts: faster cadence plus `visibilitychange` / `focus` listeners (refs: `useDriveSyncOrchestration.ts:240-241,244-245`).

This change is contained — the polling hook is the single site, and it already gates on `hasUsableAuth`. The cadence change is a numeric tuning; the listeners are a copy of the precedent with the polling-specific work swapped in.

## Requirements

- R1. The interval timer shrinks from 30_000ms to 5_000ms so ambient agent traffic surfaces within seconds, not half a minute.
- R2. A `visibilitychange` listener on `document` calls `checkAgentWrites()` immediately when the tab returns to the foreground, so writes issued while the user was away are processed on tab-focus with zero polling-tick latency.
- R3. A `focus` listener on `window` mirrors the visibilitychange listener so navigating between desktop / devtools / other windows also flushes pending writes.
- R4. The listeners are added in the same useEffect that owns the timer; they are removed in the cleanup return, so a React strict-mode double-mount does not leak listeners or fire the listener twice per tick.
- R5. The earlier 3s initial delay remains — the first check on auth flip still happens 3s after the hook mounts. The interval cadence applies after that.
- R6. The cached `hasUsableAuthValue` guard is kept so the hook still no-ops before sign-in.

## Scope Boundaries

- In scope: the polling interval and the visibilitychange / focus event wiring, plus the test that pins them and prevents regression to the 30s cadence.
- Out of scope: removing the `markApplied` poll entirely (the inbox file is the durable record; polling the file is the only way to detect Anu writes without a long-poll / websocket); changing the auth gate (`hasUsableAuth`); moving the cadence to a configuration value (no other consumer of this cadence).

### Deferred to Follow-Up Work

- Per-call debouncing of `ensureFreshToken` inside the polling loop — the 4.3.24 auth-state refactor handled this surface-by-surface; further dedup is a sweep task, not tied to the cadence change.
- Telemetry for auth transitions inside the polling loop — agent-native audit rec that lives outside this cadence fix.

## Context & Research

### Relevant Code and Patterns

- `battle-plan/src/hooks/useAgentBridgePolling.ts:11-66` — the hook being changed; current behavior described in Problem Frame.
- `battle-plan/src/hooks/useDriveSyncOrchestration.ts:239-247` — the precedent for the visibilitychange / focus listener pattern (the cleanup return mirrors the add side).
- `battle-plan/src/services/agentBridge.ts:56-65` — `init()` short-circuits on `isInitialized`. The hook calls `init()` per tick; with the new cadence (5s) this is 6 calls per minute vs the prior 2 per minute. Each call after the first is a no-op (early return on `isInitialized`). The cost is one boolean read per tick.
- `battle-plan/src/services/agentBridge.ts:67-82` — `fetchPendingWrites` returns early if `!this.isInitialized`. Each tick reads the file via `drive.readJsonFile`. With the cadence dropping 6×, the only added load is six read calls per minute when nothing has changed; the read short-circuits on a 404 in the test fixture but in production always runs against the live Drive file. This is acceptable; if it becomes a concern, the file fetch can be cached on the bridge singleton.

### Institutional Learnings

- `docs/solutions/logic-errors/offline-auth-state-unreachable-2026-07-04.md` — the auth-state machine must stay observable through `getAuthState()` reads inside the loop. The cadence change touches timing only; auth-state surface is unaffected.
- `docs/solutions/integration-issues/ensure-fresh-token-refresh-dedup-2026-07-04.md` — the `ensureFreshToken` single-flight pattern survives cadence changes because it is per-call, not per-tick. The new cadence does not change refresh semantics.
- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` — the agent path swallows Tasks-scope 403 at the `applyWrite` boundary rather than at the timer. Cadence is upstream of that surface.

### External References

- MDN: [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) — `visibilitychange` event, `document.visibilityState`, `hidden` flag semantics; used here as the source of truth for the listener contract.
- Google: [MDN Window: focus event](https://developer.mozilla.org/en-US/docs/Web/API/Window/focus_event) — `window.focus` fires on `Element.focus()` and on tab regain; the precedent `useDriveSyncOrchestration` subscribes to this on `window` rather than `document` because devtools / sub-window focus does not flip `document.visibilityState`.

## Key Technical Decisions

- The listeners mirror `useDriveSyncOrchestration` exactly: `document.addEventListener('visibilitychange', handleVisibility)` and `window.addEventListener('focus', checkAgentWrites)`. Both share the same `checkAgentWrites` callback so an upcoming tab-focus / devtools-focus fires the same path as the timer tick.
- The handler calls `checkAgentWrites` synchronously (the body is already an `async` function). React strict-mode double-mount is handled by the existing cleanup return.
- No dedup between the listener call and an in-flight timer tick. A racing listener + timer produces two parallel `mirrorInbox` + `applyWrite` sequences; the second runs see empty `fetchPendingWrites` (writes already stamped `applied_at`) and short-circuit. Acceptable cost for clarity.
- The interval period is a literal `5_000`. The plan does not introduce a configuration knob because the only consumer is this hook; if a future caller wants a different cadence, the change is local and the literal is easy to find.

## Open Questions

### Resolved During Planning

- **Listener target — `window` or `document`?** Precedent is `document` for `visibilitychange` and `window` for `focus`. The plan follows the precedent.
- **Initial delay vs cadence?** The 3s initial delay is a delay-before-first-check, not an interval. The cadence change applies to `setInterval`. Both stay.

### Deferred to Implementation

- Whether to add a `document.hidden === false` short-circuit inside `handleVisibility` so that focusing a tab that was never hidden does nothing (micro-optimization; not load-bearing).
- Whether the test should assert the listener was added on mount and removed on unmount via a spy on `document.addEventListener`. The plan pins the cadence and the registered handler presence; the spy is optional.

## Implementation Units

### U1. Drop the polling cadence to 5s and add visibilitychange / focus listeners

**Goal:** Replace the 30_000ms interval with 5_000ms and add the visibilitychange / focus listeners wired to the same `checkAgentWrites` callback.

**Requirements:** R1, R2, R3, R4, R5, R6.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/hooks/useAgentBridgePolling.ts`

**Approach:**
- Change `setInterval(checkAgentWrites, 30_000)` → `setInterval(checkAgentWrites, 5_000)`.
- Add `const handleVisibility = () => { void checkAgentWrites(); };` inside the useEffect.
- Add `document.addEventListener('visibilitychange', handleVisibility)` and `window.addEventListener('focus', handleVisibility)` next to the existing `setTimeout` / `setInterval` registrations.
- In the cleanup return, add `document.removeEventListener('visibilitychange', handleVisibility)` and `window.removeEventListener('focus', handleVisibility)` so React strict-mode double-mount does not leak.
- Keep the `hasUsableAuthValue` early return; the listeners are added inside the conditional `if (hasUsableAuthValue)` block so they are only registered after sign-in (matching the precedent).

**Patterns to follow:** `useDriveSyncOrchestration.ts:239-247` — add-then-remove in the same useEffect, with the cleanup return symmetric.

**Test scenarios:**
- Happy path: an interval is registered with a period of 5_000ms (assert via the registered handler's cadence proof — see Verification).
- Edge case: the `visibilitychange` and `focus` listeners are added on mount and removed on unmount.
- Edge case: when `hasUsableAuth(googleAuth)` is false, no listeners are added (no leak on unsign).

**Verification:** A node:test unit verifies the cadence by stubbing `setInterval` and reading the period arg. The listener add / remove symmetry is verified via `document.addEventListener` / `removeEventListener` spy. Both belong in `agentBridge.test.ts` if the hook is exported through that surface; otherwise a new `useAgentBridgePolling.test.ts` is needed. The plan defers the file decision to the implementer based on testing-pattern consistency with the existing 4.3.17 tests.

## System-Wide Impact

- **Interaction graph:** The polling loop is the only caller of `agentBridge.fetchPendingWrites` and `agentBridge.applyWrite`. The cadence change is purely timing; the interaction surface is identical.
- **Error propagation:** Listener errors throw synchronously into the global event loop. Wrap the listener body in a `try { void checkAgentWrites(); } catch` so a thrown exception does not surface as an unhandled error. The existing `checkAgentWrites` already catches and logs at line 53, so the inner `try` is sufficient.
- **State lifecycle risks:** Listener add / remove asymmetry can leak across React strict-mode double-mount. The cleanup return is the only leak vector; covered by the U1 test.
- **API surface parity:** None — only the user-facing check cycle time changes.
- **Integration coverage:** The agent-loop cadence change is observable in `db.agentInbox.applied_at` timestamps. A manual smoke test in the next release confirms: with Anu writing 3 tasks in 60s, the user sees all three within 5s of tab-focus.
- **Unchanged invariants:** The four-state Google auth model, the single-flight `runRefresh`, the `processedIds` hydrate, the `mirrorInbox` contract, and the `recordInboxResult` contract are all untouched. The cadence change is upstream of all of them.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Six calls per minute to `drive.readJsonFile` when nothing has changed adds load on Drive API quota for low-write-rate users. | `fetchPendingWrites` returns the parsed file only if the response is non-null; the existing code already short-circuits on `!this.isInitialized`. If quota becomes a concern, cache the response in `agentBridge` for ~2500ms. |
| Listener fires while a tick is in flight; both run `checkAgentWrites`. | The second invocation sees `applied_at` already set on the just-processed writes and `fetchPendingWrites` returns []. No data corruption; a microsecond of redundant work. |
| Tab visibility change at boot before the 3s initial timer fires. | Listener fires `checkAgentWrites` which still does `agentBridge.init()` then `fetchPendingWrites`; same shape as the timer. Early visibility change short-circuits to the 3s timer anyway. |

## Documentation / Operational Notes

- The polling cadence is observable in the existing diagnostic surface: the `Pending agent writes` card updates within 5s of Anu writes (or on tab focus). No new diagnostic card needed.
- The version bump follows the auto-bump workflow; no manual tag.
- No new env vars, no new dependencies.

## Sources & References

- Audit origin: agent-native audit on 2026-07-06, recommendation 10 (deferred in the original plan R10 boundary)
- Plan source: `docs/plans/2026-07-06-001-feat-widen-agent-write-contract-plan.md` § Scope Boundaries (rec 10 deferred)
- Precedent: `battle-plan/src/hooks/useDriveSyncOrchestration.ts:239-247`
- Related code: `battle-plan/src/hooks/useAgentBridgePolling.ts:11-66`
- MDN: Page Visibility API
