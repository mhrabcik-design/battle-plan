---
title: Background Google Tasks Fetch Hit 403 on Missing Optional Scope
date: 2026-07-06
category: integration-issues
module: Google OAuth / Google Tasks
problem_type: integration_issue
component: authentication
symptoms:
  - "DevTools showed content-tasks.googleapis.com 403 PERMISSION_DENIED after Google sign-in"
  - "Diagnostics and Drive sync were OK, but a red Google Tasks network error remained"
  - "Google Tasks API was called from non-Tasks views such as Battle and Diagnostics"
  - "A stale or optimistic GIS helper result could override the explicit response.scope string"
root_cause: scope_issue
resolution_type: code_fix
severity: medium
related_components:
  - App.tsx
  - googleService.ts
  - googleService.test.ts
tags:
  - google-auth
  - oauth
  - google-tasks
  - optional-scope
  - background-fetch
  - response-scope
  - permission-denied
  - drive-sync
---

# Background Google Tasks Fetch Hit 403 on Missing Optional Scope

## Problem

After the global Google auth state was fixed so that Google Tasks `403 PERMISSION_DENIED` no longer disconnected Drive sync, one red browser-console error remained: `content-tasks.googleapis.com` returned `403 PERMISSION_DENIED / Insufficient Authentication Scopes` after sign-in. The app had valid core Google OAuth scopes for Drive, Calendar, and profile data, but it was still issuing Google Tasks API requests when the optional Tasks scope was not present.

This was an integration issue between three surfaces:

1. Google Identity Services can return a token whose explicit `response.scope` string does not include `https://www.googleapis.com/auth/tasks`.
2. `googleService.ts` previously allowed a stale or optimistic `hasGrantedAllScopes(...)` helper answer to classify the optional Tasks scope as available.
3. `App.tsx` automatically fetched Google Tasks whenever global auth was usable, even outside the `tasks` view.

The user-visible impact was confusing: all sync cards were green and Drive-backed data worked, but DevTools still showed a red Tasks API failure.

## Symptoms

- Browser DevTools showed `content-tasks.googleapis.com` returning HTTP `403` with `PERMISSION_DENIED` / `Insufficient Authentication Scopes`.
- The console logged `Google Tasks scope unavailable; keeping Google auth active`, proving the 4.3.22 auth-state fix was working, but only after a network request had already failed.
- Diagnostics showed Google Auth, Tasks Drive Sync, WorkLogs Sync, and Suggestions Sync as `OK`, while DevTools still had one red Google Tasks request.
- The failed request appeared while the user was in Diagnostics / Battle / sync flow, not actively using the Google Tasks tab.

## What Didn't Work

- Treating every `403` as global auth failure fixed nothing and regressed Drive sync. A Tasks `403` means that one optional integration lacks scope; it does not mean the Drive token is invalid.
- Catching `403` after the request and returning `[]` kept the app functional, but DevTools still showed the red network request. The call had to be prevented before it hit the network.
- Relying only on `window.google.accounts.oauth2.hasGrantedAllScopes(...)` was not enough. The helper can be stale or optimistic compared with the actual token response. The explicit `response.scope` string is the stronger signal when present.
- Requesting Google Tasks unconditionally would have widened the OAuth consent prompt and made an optional integration feel required.

## Solution

Two guards were added, one at the UI orchestration boundary and one at the OAuth scope parsing boundary.

### Gate background Tasks fetches to the Tasks view

`battle-plan/src/App.tsx` previously fetched Google Tasks whenever global Google auth was usable:

```tsx
useEffect(() => {
  if (hasUsableAuth) {
    googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
  }
}, [hasUsableAuth, viewMode, activeTaskList]);
```

The fix gates the side effect to the only view that consumes Google Tasks data:

```tsx
useEffect(() => {
  if (hasUsableAuth && viewMode === 'tasks') {
    googleService.getTasks(activeTaskList).then(setGoogleTasksRaw);
  }
}, [hasUsableAuth, viewMode, activeTaskList]);
```

This prevents Diagnostics, Battle, Week, WorkLogs, Suggestions, and automatic Drive sync flows from triggering Google Tasks traffic.

### Trust `response.scope` before the GIS helper

`battle-plan/src/services/googleService.ts` now parses the explicit scope string before falling back to `hasGrantedAllScopes(...)`:

```ts
function tokenHasScopes(response: TokenResponse, scopes: string[]): boolean | null {
    if (response.scope) {
        const granted = new Set(response.scope.split(/\s+/).filter(Boolean));
        return scopes.every(scope => granted.has(scope));
    }

    const [firstScope, ...restScopes] = scopes;
    if (firstScope && window.google?.accounts?.oauth2?.hasGrantedAllScopes) {
        return window.google.accounts.oauth2.hasGrantedAllScopes(response, firstScope, ...restScopes);
    }

    return null;
}
```

If `response.scope` does not contain `https://www.googleapis.com/auth/tasks`, `tokenHasGoogleTasksScope(response)` returns `false`, `googleTasksScopeAvailable` becomes `false`, and the Google Tasks methods return their empty/no-op sentinels before touching `gapi.client.tasks.*`.

### Regression coverage

`battle-plan/src/services/googleService.test.ts` now covers both important scope cases:

- `handleTokenResponse accepts core scopes and disables Google Tasks when the token omits Tasks scope`
- `handleTokenResponse trusts response.scope over GIS helper for optional Tasks scope`

The second test installs a deliberately optimistic helper:

```ts
window.google.accounts.oauth2.hasGrantedAllScopes = () => true;
```

Then it passes a token response whose `scope` string omits Google Tasks and asserts that `getTasks('@default')` returns `[]` without calling the mocked `gapi.client.tasks.tasks.list` function.

## Why This Works

`response.scope` describes the current token. `hasGrantedAllScopes(...)` is a convenience helper that can reflect broader or stale grant state. For optional scopes, the current token's explicit scope list must win because the downstream API server will authorize the request against that token, not against the helper's opinion.

The App-level view gate removes the ambient call path entirely. A user who is looking at Diagnostics or normal sync status should not pay the cost or see failures from an optional Tasks integration they are not using. If they open the Tasks view, the service-level scope guard still prevents a Tasks API request when the token is known not to contain the Tasks scope.

The fix preserves the earlier auth-state invariant: `401` / `UNAUTHENTICATED` can move global Google auth to `OFFLINE_AUTH`, but `403` / `PERMISSION_DENIED` for an optional API remains a feature-level scope failure. Drive, WorkLogs, and Suggestions keep working.

## Prevention

- Gate optional-scope side effects by the view or feature that consumes the data, not by global `hasUsableAuth` alone.
- For OAuth token responses, parse explicit `response.scope` before consulting helper APIs. Helper APIs are fallback signals, not the source of truth when the token response carries scopes.
- Model optional integration scope as feature state (`googleTasksScopeAvailable`), separate from global auth state (`SIGNED_IN`, `REFRESH_PENDING`, `OFFLINE_AUTH`, `SIGNED_OUT`).
- Add regression tests where `response.scope` and helper APIs disagree. Happy-path tests where both agree will not catch stale-helper bugs.
- Keep `403` handling scoped to the integration that failed. Do not collapse optional-scope denial into global auth failure.

## Related Issues

- `docs/solutions/logic-errors/offline-auth-state-unreachable-2026-07-04.md` documents the complementary `401` state-machine bug. That issue was about failing to enter `OFFLINE_AUTH`; this issue is about not treating optional Google Tasks `403` as global auth and not issuing Tasks requests outside the Tasks view.
