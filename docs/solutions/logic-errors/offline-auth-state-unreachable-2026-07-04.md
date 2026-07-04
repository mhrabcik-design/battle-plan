---
title: OFFLINE_AUTH State Unreachable from 401 Path
category: logic-errors
module: Google OAuth / Drive sync auth state machine
date: 2026-07-04
problem_type: logic_error
component: authentication
severity: high
symptoms:
  - "After a 401 from a Google API, getAuthState() returns SIGNED_IN or REFRESH_PENDING instead of OFFLINE_AUTH"
  - "OFFLINE_AUTH was reachable in unit tests but not from real 401 responses"
  - "Sync icon never shows the failed state after a 401"
  - "lastRefreshFailedAt timestamp set but in-memory accessToken remained truthy"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - service_object
tags:
  - google-auth
  - oauth
  - drive-sync
  - auth-state-machine
  - 401-handling
  - gapi
---

# OFFLINE_AUTH State Unreachable from 401 Path

## Problem

A four-state Google OAuth model (`SIGNED_IN` / `REFRESH_PENDING` / `OFFLINE_AUTH` / `SIGNED_OUT`) was implemented in `battle-plan/src/services/googleService.ts` and the `OFFLINE_AUTH` state was reachable in tests by directly nulling `accessToken`, but unreachable from real 401 responses in production. After a Calendar/Drive API 401, `getAuthState()` would return `SIGNED_IN` (or `REFRESH_PENDING` past the 60-second buffer) instead of `OFFLINE_AUTH`, so the sync icon never displayed the "failed" state.

## Symptoms

- `getAuthState()` returned `SIGNED_IN` or `REFRESH_PENDING` after a real 401 in tests, never `OFFLINE_AUTH`.
- `OFFLINE_AUTH` was reachable only by tests that directly nulled `accessToken` — masking the gap between production behavior and test coverage.
- `google-auth-change` event detail was not observed carrying `state: 'OFFLINE_AUTH'` after a 401.
- Settings/offline-auth banner never fired in integration tests even though the helper code (`markAuthUnavailable`) was already correct.

## What Didn't Work

- Assuming "the helper looks right ⇒ tests pass ⇒ ship it." The simplify pass in commit `4381f1e` extracted `markAuthUnavailable` with the correct null-and-dispatch logic, but the existing tests still asserted pre-extraction behavior (`isSignedIn:false` payload, no `state` assertion) because they were written against the inline 401 handling that preceded the helper.
- Waiting for a real-world report. The bug was visible only by inspecting `getAuthState()` semantics — the surface symptom (sync icon not flipping to "failed") was subtle enough that manual testing did not surface it.

## Solution

The fix was test-side, not code-side. In commit `0575de8`, three existing tests in `battle-plan/src/services/googleService.test.ts` were updated to assert the now-reachable state. The production code (`markAuthUnavailable` at `battle-plan/src/services/googleService.ts:235`) was already correct after the simplify pass; only the test contract needed updating.

Representative shape of the fix:

```ts
// Before — asserted pre-extraction payload only
test('lazy refresh: 401 from Calendar API after successful silent refresh — addToCalendar returns sentinel, no signOut, no clear', async () => {
    // ... trigger 401 ...
    // (no state assertion; only checked event payload / no signOut)
});

// After — asserts the now-correct state transition
test('lazy refresh: 401 from Calendar API after successful silent refresh — addToCalendar returns sentinel, no signOut, no clear', async () => {
    // ... trigger 401 ...
    const statusAfter401 = googleService.getAuthStatus();
    assert.equal(statusAfter401.state, 'OFFLINE_AUTH',
        'after 401 the auth state must be OFFLINE_AUTH so the UI can show the offline-auth banner');
    assert.equal(statusAfter401.accessToken, null);
});
```

The same `state === 'OFFLINE_AUTH'` assertion was added to:
- `lazy refresh: 401 from Calendar API — deleteFromCalendar returns sentinel, no signOut, no clear` (`googleService.test.ts:408`)
- `lazy refresh integration: 401 from calendar — google-auth-change event never carries isSignedIn:false` — extended to assert the dispatched event carries `state: 'OFFLINE_AUTH'` (`googleService.test.ts:441-447`)

The `markAuthUnavailable` helper itself:

```ts
private markAuthUnavailable(): void {
    this.lastRefreshFailedAt = Date.now();
    this.accessToken = null;
    try {
        if (window.gapi?.client) {
            window.gapi.client.setToken(null);
        }
    } catch (e) {
        console.error('Failed to clear gapi client token on auth unavailability', e);
    }
    this.dispatchAuthChange();
}
```

## Why This Works

`markAuthUnavailable` does three things that flip `getAuthState()` (defined at `googleService.ts:255`) into `OFFLINE_AUTH`:

1. Sets `this.lastRefreshFailedAt = Date.now()` — the failure-marker the state machine needs.
2. Sets `this.accessToken = null` — `getAuthState`'s first guard returns early.
3. Clears `window.gapi.client.setToken(null)` — prevents the gapi client from holding a stale bearer.

Because `userEmail !== null` (set on first sign-in), the second branch of `getAuthState` matches and returns `'OFFLINE_AUTH'`. `dispatchAuthChange()` then emits the event with that state. The helper was already producing the correct state — the tests were just not observing it because they were shaped against the inline pre-extraction code path. Asserting the state directly closes the observation gap.

## Prevention

- **When extracting a helper during simplify/refactor passes, audit every test that exercises the inlined behavior and rewrite assertions against the helper's contract — not the previous shape.** A "tests still pass" check after a refactor is insufficient signal; the assertions may be passing against the wrong invariant.
- **For state-machine code, every state transition should have at least one integration test asserting the post-transition `state` value, not just side effects** (event payload, return value, return-null sentinel). State machines fail by silently NOT transitioning; the test that catches this asserts the state, not the side effect.
- **Treat "tests pass" after a refactor as insufficient signal.** Explicitly diff old assertions vs new assertions for behavioral coverage. If a test previously asserted `result === null` and the refactor changes `null` to a typed sentinel, the test passes either way — but the contract changed.
- **For auth state machines, prefer to null ALL stateful surfaces on a failure marker**, not just one. The asymmetry between "in-memory token cleared, gapi client cleared, but localStorage token preserved" is intentional (so the next `signIn` can attempt refresh) — but the in-memory `accessToken` must be nulled, not just the gapi client.

## Related Issues

- The same simplify pass (`4381f1e`) that extracted `markAuthUnavailable` also caught the `trySilentRefresh` 5-second setTimeout timer leak — see `docs/solutions/performance-issues/trysilentrefresh-settimeout-timer-leak-2026-07-04.md`.
- The in-flight refresh promise dedup introduced in the same change addressed concurrent `ensureFreshToken` calls — see `docs/solutions/integration-issues/ensure-fresh-token-refresh-dedup-2026-07-04.md`.
