---
title: trySilentRefresh 5s setTimeout Timer Leak
category: performance-issues
module: Google OAuth / GIS silent refresh
date: 2026-07-04
problem_type: performance_issue
component: authentication
severity: medium
symptoms:
  - "Event loop stays alive for 5 seconds after every successful silent refresh"
  - "5s safety setTimeout in trySilentRefresh never cleared when GIS callback resolves first"
  - "Repeated successful silent refreshes leak timer handles"
  - "Test process exit delayed by 5s after any test that exercises the success path"
root_cause: memory_leak
resolution_type: code_fix
related_components:
  - service_object
tags:
  - google-auth
  - oauth
  - settimeout
  - timer-leak
  - silent-refresh
  - gis
---

# trySilentRefresh 5s setTimeout Timer Leak

## Problem

The 5-second safety `setTimeout` in `trySilentRefresh` was never cleared on the success path. The `settled` flag prevented the late `done(false)` from double-resolving, but the timer itself kept the Node event loop alive until expiry on every successful silent refresh.

## Symptoms

- Node/test environments holding the loop open 5s after every successful silent refresh.
- Visible as delayed process exit in unit tests that exercise the success path.
- `setTimeout` handle retained per `trySilentRefresh` call — cumulative in long-running app sessions with frequent refreshes.
- Cumulative effect: a user who opens the PWA 10 times per day and triggers a refresh each time leaks 10 timer handles × 5s of event-loop hold = 50s of unnecessary "keep-alive" per day.

## What Didn't Work

- The `settled` flag guard (`if (settled) return`) in commit `ba085d8` correctly prevented the late callback from racing the real one, but it did not release the timer. Resolving a Promise does not cancel pending timers; only `clearTimeout` does.
- Treating the bug as a test-isolation issue. The timer leaked in production too (browser tabs hold the timer handle, which prevents the JS engine from garbage-collecting the surrounding closure).

## Solution

File: `battle-plan/src/services/googleService.ts`, `trySilentRefresh` (around line 139). Commit `97eaf58`.

Before:

```ts
return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
        if (settled) return;
        settled = true;
        if (result) this.lastRefreshFailedAt = null;
        else this.lastRefreshFailedAt = Date.now();
        resolve(result);
    };
    // ... GIS callback fires done(true) when token arrives ...
    setTimeout(() => done(false), 5000);  // <-- handle dropped
});
```

After:

```ts
return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const done = (result: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
            clearTimeout(timer);  // <-- release the handle
            timer = null;
        }
        if (result) this.lastRefreshFailedAt = null;
        else this.lastRefreshFailedAt = Date.now();
        resolve(result);
    };
    // ... GIS callback fires done(true) when token arrives ...
    timer = setTimeout(() => done(false), 5000);  // <-- handle captured
});
```

## Why This Works

`done` is the single convergence point for three paths: GIS success callback, GIS `error_callback`, the 5s safety timeout, and the synchronous `try/catch` around `requestAccessToken`. Any of those resolving the promise must also cancel the other pending triggers. Capturing the timer handle in a closure-scoped variable and `clearTimeout`-ing it inside `done` ensures whichever path fires first releases the handle for the GC. The `timer !== null` guard prevents a redundant `clearTimeout` after the timeout itself fires (which would be a no-op but is unnecessary work and a code smell).

## Prevention

- **Every `setTimeout` / `setInterval` introduced inside a Promise constructor should be assigned to a handle and cleared in the resolver** — not just gated by a "settled" flag. The settled flag protects Promise resolution; `clearTimeout` protects the event loop.
- **Lint rule or convention**: any function containing both `setTimeout` and `resolve`/`reject` must also contain `clearTimeout`. Tools like `eslint-plugin-no-unsanitized-timer` or a custom rule can enforce this.
- **For long-lived singletons (like `googleService`), timer leaks compound** — prefer a single class-scoped timer handle reset per call rather than relying on GC.
- **In tests, fast-exit is a smoke signal.** If a test process takes 5s to exit when it should take 50ms, a timer is leaking. Add a test-level timeout in the test runner config (e.g., `--test-timeout=10000` in `node:test`) to catch regressions.

## Related Issues

- The same `trySilentRefresh` function was the target of the in-flight promise dedup fix — see `docs/solutions/integration-issues/ensure-fresh-token-refresh-dedup-2026-07-04.md`.
- The OFFLINE_AUTH state unreachability fix touched the same `googleService.ts` module — see `docs/solutions/logic-errors/offline-auth-state-unreachable-2026-07-04.md`.
