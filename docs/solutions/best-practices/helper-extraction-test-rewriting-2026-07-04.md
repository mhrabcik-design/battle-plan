---
title: Helper Extraction Requires Test Rewriting, Not Just Test Passing
category: best-practices
module: refactoring
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Extracting a private method or function from inline code"
  - "Adding a state machine transition to an existing flow"
  - "Adding resource cleanup to async code"
  - "Adding concurrency control (dedup, single-flight, cache)"
tags:
  - refactoring
  - testing
  - helper-extraction
  - state-machines
  - concurrency
---

# Helper Extraction Requires Test Rewriting, Not Just Test Passing

## Context

When extracting a helper from inline code during a simplify/refactor pass, "tests still pass" is necessary but insufficient. Tests written against the inline behavior may continue to assert the pre-extraction contract while the helper establishes a new invariant.

The simplify pass on the Battle Plan PWA's quiet Google auth change (commit `4381f1e`) produced three bugs that survived typecheck and the full test suite (54/54 pass). All three had the same shape: a helper was extracted, the helper was correct, but the existing tests continued to assert against the pre-extraction contract.

## Guidance

After any helper extraction across an async/state/lifecycle boundary, perform these four steps before declaring the work done:

### 1. Diff old assertions against the new contract

For each test that exercises the inlined behavior, identify what invariant the assertion checks. If the helper changes the invariant (e.g. adds a state-machine transition, changes the payload shape, adds cleanup, introduces concurrency control), rewrite the assertion to check the new invariant — not the old one. "Tests pass" after a refactor is insufficient signal: the assertions may be passing against the wrong invariant.

Concretely, write a list:

| Test file:line | Old assertion | Old invariant | New invariant (after helper) | Action |
|---|---|---|---|---|
| (example) `googleService.test.ts:332` | `event.detail.isSignedIn === false` | inline 401 handler dispatched `{isSignedIn:false}` | `markAuthUnavailable` dispatches `{state: 'OFFLINE_AUTH'}` | rewrite assertion to check `state` |
| (example) `googleService.test.ts:450` | `result === false` (timeout fires `done(false)`) | race-fix assertion | `clearTimeout(handle)` actually released the handle | add a new test for timer retention |

### 2. Add a state-transition test, not a side-effect test

State machines fail by silently NOT transitioning. The test that catches this asserts the post-transition state value, not the event payload, return value, or null sentinel.

For the OFFLINE_AUTH bug: the existing test checked `event.detail.isSignedIn === false` (the post-state-machine payload) and `localStorage.removeItem` was not called (a side effect). Neither assertion caught the fact that `getAuthState()` never returned `'OFFLINE_AUTH'` after a real 401. The fix was a new assertion: `googleService.getAuthStatus().state === 'OFFLINE_AUTH'`. That assertion is the kind that fails when the helper does not actually transition the state machine.

Pattern: when extracting a helper that introduces a new state-transition, write the test as `expect(state).toBe(<new state>)`, not `expect(sideEffect).toHaveBeenCalled()`. The state assertion fails on the bug; the side-effect assertion does not.

### 3. Add a resource-cleanup test, not a "result is correct" test

For async code, the leak is in the lifecycle, not the result. `setTimeout` handles that are never `clearTimeout`-ed keep the event loop alive. The `trySilentRefresh` timer leak (commit `97eaf58`) survived because the existing test only checked that the result was correct on the success path. The timer-handle release was never asserted.

Patterns:

- For timer / interval cleanup: assert that the handle is captured, or use a test runner timeout to catch leaked event loops (e.g., `node --test-timeout=10000`). A test that takes 5s when it should take 50ms is a smell.
- For AbortController / fetch cancellation: assert that `controller.abort()` is called when the consumer is disposed.
- For WebSocket / EventSource / event listeners: assert that `.close()` / `.removeEventListener()` is called on cleanup paths.

### 4. Add a concurrency test that fires N concurrent calls

For any async method with side effects (network, prompts, dispatches), the "first call works" test is insufficient. A test that fires N concurrent calls and asserts the underlying primitive was invoked exactly once is the only shape that catches missing dedup.

The `runRefresh` dedup (commit `a132798`) was added in the same change that introduced the helper. The test that caught the bug if it had been missing:

```ts
test('runRefresh: concurrent ensureFreshToken invocations only call initTokenClient once', async () => {
    // ... set up REFRESH_PENDING state ...
    let trySilentRefreshCalls = 0;
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh =
        async () => { trySilentRefreshCalls++; return refreshPromise; };

    const taskListsPromise = svc.getTaskLists();
    const tasksPromise = svc.getTasks('@default');

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(trySilentRefreshCalls, 1, 'concurrent ensureFreshToken calls must share a single in-flight refresh');

    release();
    await Promise.all([taskListsPromise, tasksPromise]);
});
```

The `assert.equal(trySilentRefreshCalls, 1, ...)` is the key. "First call works" would be `assert.equal(trySilentRefreshCalls, 1)` after a single call — passes even without the dedup. The N-concurrent shape is the only thing that fails when dedup is missing.

## Why This Matters

The three bugs from the Battle Plan session are all the same pattern at three different boundaries:

| Helper | Boundary | Test gap | Symptom |
|---|---|---|---|
| `markAuthUnavailable` | state machine | asserted payload, not `state` | OFFLINE_AUTH unreachable from 401 |
| `trySilentRefresh` | async lifecycle | asserted result, not handle release | 5s event-loop hold per call |
| `runRefresh` | async concurrency | no concurrent-call test | N parallel GIS prompts per user intent |

The fix cost three commits (`0575de8`, `97eaf58`, `a132798`) plus a follow-up simplify pass. The pattern repeats whenever a helper crosses an async / state / lifecycle boundary. Skipping any of the four steps above produces a "tests pass" win that is actually a silent regression.

## When to Apply

- Reviewing a PR that introduces a new helper extracted from inline code.
- Writing a "simplify" or "extract method" commit.
- Adding concurrency control (single-flight, dedup, cache).
- Adding resource cleanup to async code (setTimeout, setInterval, fetch cancellation, AbortController wiring, event listener lifecycle).
- Adding a state machine transition to an existing flow (auth state, workflow state, lifecycle state).

## Examples

The three Battle Plan bugs are the canonical examples — see the related docs in `docs/solutions/`:

- `docs/solutions/logic-errors/offline-auth-state-unreachable-2026-07-04.md` — state machine test gap (step 2)
- `docs/solutions/performance-issues/trysilentrefresh-settimeout-timer-leak-2026-07-04.md` — async lifecycle test gap (step 3)
- `docs/solutions/integration-issues/ensure-fresh-token-refresh-dedup-2026-07-04.md` — concurrency test gap (step 4)
