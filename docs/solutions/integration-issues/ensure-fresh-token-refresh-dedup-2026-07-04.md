---
title: Concurrent ensureFreshToken Triggers N Parallel Silent Refreshes
category: integration-issues
module: Google OAuth / ensureFreshToken concurrency
date: 2026-07-04
problem_type: integration_issue
component: authentication
severity: medium
symptoms:
  - "Concurrent ensureFreshToken() calls (e.g. getTaskLists + getTasks) each invoke trySilentRefresh independently"
  - "N parallel GIS prompts fired for a single user intent"
  - "Duplicate google-auth-change events on each refresh attempt"
  - "Token state could thrash if GIS callbacks for the parallel prompts interleaved"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - service_object
tags:
  - google-auth
  - oauth
  - drive-sync
  - promise-dedup
  - concurrent-requests
  - silent-refresh
---

# Concurrent ensureFreshToken Triggers N Parallel Silent Refreshes

## Problem

Two concurrent callers (e.g. `getTaskLists` and `getTasks` on the same render) both observed `state === 'REFRESH_PENDING'`, both called `ensureFreshToken()`, both awaited their own `trySilentRefresh()` invocation, and both issued independent GIS `requestAccessToken({ prompt: 'none' })` calls — surfacing N parallel prompts and N parallel state dispatches.

## Symptoms

- Settings page render (which fetches task lists + tasks concurrently) issued multiple GIS prompts in quick succession.
- Duplicate `google-auth-change` events on each refresh attempt.
- Token state could thrash if GIS callbacks for the parallel prompts interleaved (one prompt returns success, sets token; the other returns failure, clears `lastRefreshFailedAt` to `null` but does not clear the in-memory token).
- Observable in test logs: multiple `trySilentRefresh` invocations per test instead of one.

## What Didn't Work

- The `REFRESH_PENDING` state check at the top of `ensureFreshToken` correctly identified "needs refresh" but provided no coordination between concurrent callers. Each caller still issued its own refresh attempt because there was no shared in-flight promise.
- Adding a sleep or "is already refreshing" boolean: race-prone (the read-modify-write window between checking the boolean and setting it allows two concurrent callers to both observe "not refreshing" and both proceed).
- Returning the same Promise to all callers without storing it: requires the producer to be invoked first and synchronously publish the Promise to other callers, which is hard to reason about.

## Solution

File: `battle-plan/src/services/googleService.ts`. `runRefresh` (line 128) added as a single-flight wrapper; `ensureFreshToken` (line 269) now delegates to it. Commit `a132798`.

Before:

```ts
private async ensureFreshToken(): Promise<'ok' | 'auth-unavailable'> {
    const state = this.getAuthState();
    if (state === 'SIGNED_IN') return 'ok';
    if (state === 'REFRESH_PENDING') {
        const refreshed = await this.trySilentRefresh();  // each caller fires its own
        if (refreshed) {
            if (this.getAuthState() === 'SIGNED_IN') return 'ok';
            return 'auth-unavailable';
        }
        return 'auth-unavailable';
    }
    return 'auth-unavailable';
}
```

After:

```ts
private refreshInFlight: Promise<boolean> | null = null;

private async runRefresh(): Promise<boolean> {
    if (this.refreshInFlight) {
        return this.refreshInFlight;  // dedupe — share the in-flight promise
    }
    const promise = this.trySilentRefresh().finally(() => {
        this.refreshInFlight = null;  // clear slot only after settle
    });
    this.refreshInFlight = promise;
    return promise;
}

private async ensureFreshToken(): Promise<'ok' | 'auth-unavailable'> {
    const state = this.getAuthState();
    if (state === 'SIGNED_IN') return 'ok';
    if (state === 'REFRESH_PENDING') {
        const refreshed = await this.runRefresh();  // shared across callers
        if (refreshed) {
            if (this.getAuthState() === 'SIGNED_IN') return 'ok';
            return 'auth-unavailable';
        }
        return 'auth-unavailable';
    }
    return 'auth-unavailable';
}
```

A new test (`googleService.test.ts:498-535`) asserts that two concurrent `ensureFreshToken` invocations share a single `trySilentRefresh` call:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('runRefresh: concurrent ensureFreshToken invocations only call initTokenClient once (in-flight dedup)', async () => {
    // ... set REFRESH_PENDING state ...
    let trySilentRefreshCalls = 0;
    let release: () => void = () => {};
    const refreshPromise = new Promise<boolean>((resolve) => {
        release = () => resolve(true);
    });
    (svc as unknown as { trySilentRefresh: () => Promise<boolean> }).trySilentRefresh = async () => {
        trySilentRefreshCalls++;
        return refreshPromise;
    };

    const taskListsPromise = svc.getTaskLists();
    const tasksPromise = svc.getTasks('@default');

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(trySilentRefreshCalls, 1, 'concurrent ensureFreshToken calls must share a single in-flight refresh, not each invoke trySilentRefresh');

    release();
    const [taskLists, tasks] = await Promise.all([taskListsPromise, tasksPromise]);
    assert.ok(Array.isArray(taskLists));
    assert.ok(Array.isArray(tasks));
});
```

## Why This Works

The pattern is single-flight via shared in-flight promise. The first caller that observes `REFRESH_PENDING` creates the promise and stores it on the instance; every concurrent caller within the same refresh window receives the same `Promise<boolean>` and awaits it. Using `.finally(() => this.refreshInFlight = null)` — rather than clearing in a `.then`/`.catch` — guarantees the slot is released regardless of success/failure and before any downstream `.then` chain on the awaiting caller runs. The slot is cleared on the original promise, not on each awaiter's downstream promise, so the dedup window is exactly the lifetime of one refresh attempt.

## Prevention

- **Any async method that may be triggered concurrently** (React effects, parallel `Promise.all` consumers, event handlers) **and has observable side effects** (network, prompts, dispatches) should go through a single-flight wrapper. The shape is small enough to extract into a helper:

  ```ts
  function singleFlight<T>(inFlightRef: { current: Promise<T> | null }, fn: () => Promise<T>): Promise<T> {
      if (inFlightRef.current) return inFlightRef.current;
      inFlightRef.current = fn().finally(() => { inFlightRef.current = null; });
      return inFlightRef.current;
  }
  ```

- **Always use `.finally` for slot cleanup, not `.then`/`.catch`.** A `.then`-only clear would leak the slot on rejection. A `.catch`-only clear would leak on success. `.finally` is the only handler that fires for both.
- **Add an integration test that fires N concurrent calls of a public method and asserts the underlying primitive was invoked exactly once.** This is the only test shape that catches a missing dedup wrapper without ambiguity. A "first call wins" test or a "second call returns cached" test does not catch the case where both calls independently re-execute.
- **Document the dedup window.** If the in-flight promise lives 5 seconds (or until the underlying call resolves), state that explicitly. Future readers will assume "single-flight forever" and be confused when the second concurrent call 6 seconds later does NOT share.

## Related Issues

- The `trySilentRefresh` body was the underlying primitive being deduped — its timer leak is documented at `docs/solutions/performance-issues/trysilentrefresh-settimeout-timer-leak-2026-07-04.md`.
- The `ensureFreshToken` callers (`getTaskLists`, `getTasks`, `addToCalendar`, etc.) all benefit from this dedup without any per-caller change. The single-flight wrapper is invisible to the public API.
- The OFFLINE_AUTH state unreachability fix touched the same `googleService.ts` module — see `docs/solutions/logic-errors/offline-auth-state-unreachable-2026-07-04.md`.
