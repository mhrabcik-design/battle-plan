---
title: Quiet Google Auth for Drive Sync
type: feat
status: completed
date: 2026-07-03
origin: docs/brainstorms/2026-07-03-quiet-google-auth-for-drive-sync.md
---

# Quiet Google Auth for Drive Sync

## Summary

Replace today's "expired token → `signOut()` → user re-prompts on every cold launch" behavior with a silent, lazy refresh model. Every public Google method on `googleService` plus `driveJsonStore` checks auth state and attempts `trySilentRefresh()` before each call; if the refresh fails, the call returns an "auth unavailable" signal instead of clearing local credentials. A new four-state auth model (SIGNED_IN / REFRESH_PENDING / OFFLINE_AUTH / SIGNED_OUT) replaces the boolean `isSignedIn`, surfaced via a quiet icon in the Sidebar and mobile header. First sign-in requests a longer-lived token via `prompt: 'consent'` + `include_granted_scopes: 'true'`. Manual re-auth stays in Settings as the only interactive trigger.

## Problem Frame

The user reports that the Battle Plan PWA surfaces a Google sign-in prompt too often — most acutely on cold phone launches in PWA-installed mode where Google's `prompt: 'none'` silent refresh cannot succeed because the browser lacks a Google session cookie. The current behavior in `googleService.ts:404-407` and `:424-427` is to call `signOut()` on any 401 from Calendar APIs, which clears `localStorage` and forces the next launch to show an interactive popup. The fix is to stop treating an expired token as a license to delete local credentials and instead fall through to a graceful offline path the user can re-enter manually. See origin doc for full problem statement, FR1–FR6 functional requirements, and success criteria SC1–SC4.

## Requirements

- **R1.** Lazy silent refresh: every public method on `googleService` (calendar, tasks) and the request path in `driveJsonStore` checks auth status before each call and attempts `trySilentRefresh()` on expiry, never clearing local credentials on failure.
- **R2.** First sign-in (when no prior token exists in localStorage) requests a longer-lived token via `prompt: 'consent'` + `include_granted_scopes: 'true'`. Subsequent silent refreshes use `prompt: 'none'`.
- **R3.** Replace boolean `GoogleAuthStatus.isSignedIn` with a four-state model: `SIGNED_IN`, `REFRESH_PENDING`, `OFFLINE_AUTH`, `SIGNED_OUT`. Existing consumers compile via enum-to-boolean mapping at the boundary.
- **R4.** `signOut()` is callable only from a user-initiated action (the Settings "Odpojit" / "Reconnect Google" control). Auto-clear on 401 is removed. 401 from any Google API surfaces as "auth unavailable" return, not a throw that triggers re-prompt.
- **R5.** A sync icon in the Sidebar (desktop) and the mobile header visually distinguishes three states — in sync / sync pending / sync failed — without text, without popups, without toasts.
- **R6.** All current capabilities preserved: calendar event CRUD, task list and task CRUD, Drive file read/write, offline-mode behavior of all local data.
- **R7.** Test coverage for the new auth state machine and the lazy refresh flow, following the existing `node:test` + `node:assert` + `globalThis.window = ...` pattern.

**Origin actors:** A1 (mobile app user on PWA-installed phone), A2 (desktop app user in browser).
**Origin flows:** F1 (first-time sign-in), F2 (cold app launch), F3 (token expiry during active session), F4 (user revokes access from Google account).
**Origin acceptance examples:** AE1 (covers R2: first sign-in shows consent screen, gets long-lived token), AE2 (covers R1 + R5: cold launch silently refreshes if possible, falls to offline with soft icon), AE3 (covers R4: user manually triggers reconnect from Settings).

## Scope Boundaries

- **No server-side OAuth proxy.** Out of product identity (origin "Outside this product's identity" + codebase's local-first posture). Refresh tokens require a confidential client and a backend; not in scope.
- **No background polling timer** that retries `trySilentRefresh()` on a schedule. The lazy-on-call pattern is sufficient and avoids battery/data cost. The existing `visibilitychange` / `focus` listener in `useDriveSyncOrchestration` is preserved as-is.
- **No OAuth scope changes.** Scope set stays at `calendar.events + drive + tasks`. Changing scopes would invalidate existing user tokens and is explicitly out of scope.
- **No toast, banner, modal, or alert** for auth state changes during normal use. The user explicitly chose the quietest indicator option.
- **No analytics or event tracking** for auth state transitions.
- **No migration of existing users' stored tokens.** The first launch after this change treats the user's existing `localStorage` token as `REFRESH_PENDING` and attempts silent refresh; if it is still valid, the user never notices the change.

### Deferred to Follow-Up Work

- **Reconnect-from-settings copy** ("Reconnect Google" button instead of today's "Google Přihlášení" / "Odpojit"): origin doc FR5 mentions this label, but the current "Odpojit" + "Google Přihlášení" labels are functionally equivalent. Implementation may rename as a small polish in a later PR; not blocking. The interactive sign-in trigger remains in Settings either way.

## Context & Research

### Relevant Code and Patterns

- `battle-plan/src/services/googleService.ts` — current singleton. Methods to be retrofitted: `getTaskLists`, `getTasks`, `createGoogleTask`, `updateGoogleTask`, `deleteGoogleTask`, `addToCalendar`, `deleteFromCalendar`. The two calendar methods at `:404-407` and `:424-427` currently call `this.signOut()` on 401 — this is the behavior to remove.
- `battle-plan/src/services/driveJsonStore.ts:239` — reads `google_access_token` directly from localStorage to populate the request `Authorization` header. Bypasses `googleService`. Plan decision: this class calls `googleService.getAuthStatus()` + `googleService.trySilentRefresh()` before each request; it does NOT import a new `ensureFreshToken` method (variant B chosen).
- `battle-plan/src/hooks/useDriveSyncOrchestration.ts:48-54` — already has a startup silent-refresh pattern inside the orchestration `useEffect`. Plan preserves this code path; the lazy refresh in `googleService` is additive, not replacement.
- `battle-plan/src/App.tsx:141-194` — startup `googleService.init()` followed by a one-shot silent refresh attempt at `:147-150`. Plan preserves this; it is the warmup before any Drive call happens.
- `battle-plan/src/services/taskDriveBackup.ts`, `battle-plan/src/services/workLogsSync.ts`, `battle-plan/src/services/suggestionsSync.ts`, `battle-plan/src/services/agentBridge.ts` — all go through `driveJsonStore` for Drive I/O. They inherit the lazy-refresh fix transparently via `driveJsonStore`. No per-service changes needed.
- `battle-plan/src/hooks/useTaskCommands.ts:124-135` — `handleSyncToGoogle` currently `alert()`s on any thrown error. Plan adds a typed error class for "auth unavailable" that this hook recognizes and swallows silently.
- `battle-plan/src/components/SettingsModal.tsx:96-119` — only place today where `signIn()` / `signOut()` are user-invoked. Plan preserves this as the single interactive trigger.
- `battle-plan/src/components/Sidebar.tsx` — currently has no sync icon. Plan adds one (see U6). Sidebar is `hidden md:flex` (`:27`), so the mobile header at `battle-plan/src/App.tsx:530-592` also needs the same icon — see call-out below.
- `battle-plan/src/types.ts:11-14` and `battle-plan/src/services/googleService.ts:60-63` — `GoogleAuthStatus` declared twice. Plan keeps both declarations and updates both (mirror changes); the duplication is acknowledged in repo research and not removed in this plan to keep diff scoped.
- Test pattern: `battle-plan/src/services/driveJsonStore.test.ts:1-9` — uses `node:test` + `node:assert/strict` + global `window`/`localStorage` assignment. Plan follows this same pattern for the new `googleService.test.ts`. Runner: `node --experimental-strip-types <file>` chained in `package.json:10`.

### Institutional Learnings

- `docs/plans/2026-07-03-001-refactor-drive-json-store-and-app-shell-plan.md:201` (KTD2): "Keep `googleService` as the owner of authentication, Google Tasks, and Calendar APIs." The stop condition for that plan is "Stop if the work requires changing OAuth scopes ... or replacing Drive storage." This plan respects both — auth stays in `googleService`, scopes do not change, Drive storage is not replaced.
- `docs/plans/2026-06-30-003-refactor-runtime-traceability-and-architecture-plan.md` (U2 Sync and OAuth Diagnostic Health Model): "Google auth can be healthy while WorkLogs Drive sync is stale, so Diagnostics should keep Google auth, Tasks, WorkLogs, and Suggestions separate." The four-state auth model in this plan is a natural input to that diagnostics model. This plan does not change the diagnostics surface itself but preserves the auth-state handoff shape (the dispatched `google-auth-change` event detail) so the diagnostics plan can consume it later without breaking changes.
- `docs/STATUS-progres-report.md:29` — "Google Auth Persistence (Silent refresh, Login hint, zapamatování účtu)" listed as 95% shipped. This plan is a deepening of that existing feature, not net-new work.
- The repo's `docs/solutions/` directory contains only two unrelated files; no institutional learnings on Google auth, silent refresh, OAuth tokens, or PWA-installed browser session quirks exist. None surfaced as constraints.
- `docs/STRATEGY.md` does not exist in this repo (referenced in node labels but not on disk). The offline-first posture is corroborated across the codebase (IndexedDB-as-source, `vite-plugin-pwa` in `vite.config.ts:18`) and through the absence of any server dependency, so the no-server-proxy decision is sound but worth flagging for future grep.

### External References

None used. The repo-research + learnings-research agents covered the necessary surface; no external doc fetches were triggered.

## Key Technical Decisions

- **Four-state auth enum, not boolean.** `GoogleAuthStatus.isSignedIn` is replaced by `GoogleAuthStatus.state: 'SIGNED_IN' | 'REFRESH_PENDING' | 'OFFLINE_AUTH' | 'SIGNED_OUT'`. Consumers compile via a helper that maps the new state to the old boolean at the boundary. Reason: the boolean collapsed two distinct cases (token present-but-stale vs. token absent-after-revocation) into one, which was the root cause of the user-facing prompt loop.
- **`signOut()` is user-only.** No code path besides the Settings "Odpojit" control may call `signOut()`. The auto-clear on 401 in calendar methods is replaced with a return value of "auth unavailable" (a typed error class or a discriminated result; the exact shape is implementation-time). Reason: matches origin R2 + R4 and prevents regression of the current "any 401 nukes credentials" behavior.
- **`DriveJsonStore` calls `googleService.getAuthStatus()` + `trySilentRefresh()` directly, no new method.** This is variant B from planning. Reason: smallest coupling — `DriveJsonStore` already imports `googleService` for nothing today and gains only two function calls. Avoids introducing a new public API surface on `googleService` that future changes would have to maintain.
- **First sign-in creates a fresh `TokenClient` with `prompt: 'consent'` + `include_granted_scopes: 'true'`.** The existing singleton `this.tokenClient` cannot carry these options (they live on `initTokenClient` config, not on `requestAccessToken`). First sign-in creates a one-shot client, captures the response, and discards it. Subsequent silent refreshes use the existing singleton. Reason: matches origin FR2.
- **`google-auth-change` event detail carries the new state, not a boolean.** Detail shape changes from `{ isSignedIn, accessToken }` to `{ state, accessToken }` (or both for backwards compatibility during the transition — implementation-time choice). Reason: the single subscriber in `App.tsx:170-179` currently reads only `isSignedIn`, which loses the `REFRESH_PENDING` distinction. The change forces the new state to flow through naturally.
- **Sync icon lives in both Sidebar and mobile header.** See call-out 3 in the synthesis. Reason: `Sidebar` is `hidden md:flex`, so an icon added only there is invisible on mobile, which is precisely the device where the original pain occurs.

## Open Questions

### Resolved During Planning

- **Q: Where does the lazy refresh for Drive calls live?** Resolved: variant B — `DriveJsonStore` calls `googleService.getAuthStatus()` + `trySilentRefresh()` directly. No new public method on `googleService`.
- **Q: What replaces `signOut()` on 401 in calendar methods?** Resolved: a "auth unavailable" return signal (typed error class or discriminated result). The exact shape is implementation-time. Callers like `useTaskCommands.handleSyncToGoogle` recognize the signal and suppress `alert()` for it.
- **Q: Does `getAuthStatus()` become the new `isSignedIn`?** Resolved: yes, but renamed to `getAuthState()` to make the new semantics explicit. A compatibility helper `getAuthStatus(): GoogleAuthStatus` (boolean-shaped) may be retained alongside for the eight existing call sites that only check `isSignedIn` — implementation-time decision based on how much churn the call-site updates cause.

### Deferred to Implementation

- **Exact error class name and shape for "auth unavailable".** A typed error class (`AuthUnavailableError extends Error`) or a discriminated result enum (`{ kind: 'auth-unavailable', reason?: string }`) — implementer picks based on what reads best at the call sites. Either is acceptable per origin.
- **Whether to keep `GoogleAuthStatus` as a backwards-compatible boolean-shaped type alongside the new enum.** Implementation-time: if all eight call sites can be updated cheaply in one PR, drop the boolean; if not, retain a compat helper and remove in a follow-up.
- **The `setTimeout(() => done(!!this.accessToken), 5000)` race in `trySilentRefresh` (`googleService.ts:198`) that resolves to `true` if any access token exists in memory.** This is a pre-existing bug surfaced by repo research. The plan fixes it (replace with `done(false)` when the GIS callback did not fire before timeout), but the exact fix shape is implementation-time.
- **Czech strings for any new UI labels.** Today all visible UI strings are Czech. Plan preserves this convention but does not specify exact wording.

## Implementation Units

### U1. Auth state model

**Goal:** Introduce the four-state auth enum on `GoogleService` and replace the boolean `isSignedIn` semantics.

**Requirements:** R3.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/services/googleService.ts` (introduce `GoogleAuthState` type, `getAuthState()` method; keep `getAuthStatus()` as a compat shim during transition)
- Modify: `battle-plan/src/types.ts` (extend `GoogleAuthStatus` interface or replace with the new shape, per implementation-time call-site analysis)

**Approach:**
- Define `GoogleAuthState = 'SIGNED_IN' | 'REFRESH_PENDING' | 'OFFLINE_AUTH' | 'SIGNED_OUT'`.
- Add a `private computeState(): GoogleAuthState` that reads `accessToken`, `expiresAt`, and the presence of `google_user_email` in localStorage, and returns the appropriate state.
- Replace `getAuthStatus()` body to return `{ state, accessToken }` instead of `{ isSignedIn, accessToken }`. Update `handleAuthChange` in `App.tsx:170-179` to consume the new shape.
- For backward compatibility in this PR, the eight existing call sites (`App.tsx`, `useTaskCommands.ts`, `useAgentBridgePolling.ts`, `useSuggestionsBadge.ts`, `useDriveSyncOrchestration.ts`, `FocusEditor.tsx`, `SuggestionsPage.tsx`, `WorkLogsPage.tsx`, `SettingsModal.tsx`) read `state` directly or via a compat helper.

**Execution note:** Add characterization coverage of the existing four observable behaviors (fresh token / expired-but-storable / no-token / user-signed-out) before changing the shape, so the refactor has tests that lock in the contract.

**Patterns to follow:**
- Existing `getAuthStatus` shape at `googleService.ts:218-224` and `types.ts:11-14` — keep declarations in sync.
- Existing event-based state propagation pattern (`google-auth-change` CustomEvent at `googleService.ts:92-95, 122-124, 179-181, 253-255`).

**Test scenarios:**
- Happy path — fresh token in localStorage and within expiry window → state is `SIGNED_IN`, `accessToken` is set.
- Happy path — no token, no userEmail in localStorage (never signed in) → state is `SIGNED_OUT`, `accessToken` is null.
- Happy path — token present, userEmail present, but `expiresAt` within 60s of now → state is `REFRESH_PENDING`, `accessToken` still set (token is not cleared).
- Happy path — user previously signed out (`signOut()` invoked) → state is `SIGNED_OUT`, all localStorage keys absent.
- Edge case — token expires while app is idle, app reopens → state is `REFRESH_PENDING` (NOT `OFFLINE_AUTH`, because we have a stored token to attempt to refresh).
- Edge case — token was never present, userEmail was cleared → state is `SIGNED_OUT`.

**Verification:**
- `node:test` for `googleService.test.ts` passes.
- The eight call sites compile with the new shape (TypeScript strict mode catches any drift).

### U2. Lazy silent refresh inside `googleService` methods

**Goal:** Every public Calendar/Tasks method on `googleService` checks auth state and attempts silent refresh before executing; no method ever clears local credentials or shows a popup on failure.

**Requirements:** R1, R4.

**Dependencies:** U1 (state model).

**Files:**
- Modify: `battle-plan/src/services/googleService.ts` (each of `getTaskLists`, `getTasks`, `createGoogleTask`, `updateGoogleTask`, `deleteGoogleTask`, `addToCalendar`, `deleteFromCalendar`)
- Test: `battle-plan/src/services/googleService.test.ts`

**Approach:**
- Add a private `private async ensureFreshToken(): Promise<'ok' | 'auth-unavailable'>` that calls `getAuthState()` and, if state is `REFRESH_PENDING`, attempts `trySilentRefresh()`.
- Each public method calls `ensureFreshToken()` as its first step. On `'auth-unavailable'`, the method returns the existing "no auth" sentinel (empty array, null, undefined — depends on the method's existing return shape).
- Remove the `this.signOut()` calls in `addToCalendar` (`googleService.ts:404-407`) and `deleteFromCalendar` (`googleService.ts:424-425`). Replace the user-facing Czech error throw ("Relace vypršela...") with the same "auth unavailable" return sentinel the other methods use.
- Fix the `setTimeout(() => done(!!this.accessToken), 5000)` race in `trySilentRefresh` (`googleService.ts:198`): resolve `false` (not `!!this.accessToken`) when the GIS callback has not fired before timeout.
- Update the `google-auth-change` event detail payload from `{ isSignedIn, accessToken }` to `{ state, accessToken }`.

**Execution note:** Test-first. Write the test scenarios below, watch them fail against today's implementation, then change the methods.

**Patterns to follow:**
- Existing `trySilentRefresh()` at `googleService.ts:150-200` — reuse as the refresh primitive.
- Existing error-handling shape: methods return empty arrays / null / undefined on auth failure today (`googleService.ts:259, 270, 285, 308, 323, 336, 414`).

**Test scenarios:**
- Happy path — fresh token, method called → API call proceeds without `trySilentRefresh`.
- Happy path — expired token (state `REFRESH_PENDING`), `trySilentRefresh` succeeds → API call proceeds.
- Error path — expired token, `trySilentRefresh` fails → method returns sentinel value (empty array for `getTaskLists`/`getTasks`, null for `createGoogleTask`/`updateGoogleTask`, undefined for the rest), localStorage NOT cleared, `signOut()` NOT called.
- Error path — 401 response from Calendar API after a successful silent refresh → method returns sentinel value, `signOut()` NOT called, localStorage NOT cleared.
- Integration — a 401-throwing calendar method called via the public surface no longer dispatches `google-auth-change` with `isSignedIn: false`.

**Verification:**
- `node:test` for `googleService.test.ts` passes.
- A test that asserts `signOut()` is never called on the 401 path passes (using a spy on the singleton).
- A test that asserts `localStorage.removeItem` is never called during a 401-pass-through path passes.

### U3. First-sign-in extended-lifetime token

**Goal:** When the user signs in for the first time (no prior token in localStorage), request a longer-lived access token via `prompt: 'consent'` + `include_granted_scopes: 'true'`.

**Requirements:** R2.

**Dependencies:** U1.

**Files:**
- Modify: `battle-plan/src/services/googleService.ts` (`signIn()` method at `:226-232`)

**Approach:**
- In `signIn()`, detect first sign-in by `localStorage.getItem('google_user_email')` being null.
- On first sign-in, create a fresh one-shot `TokenClient` via `initTokenClient` with `prompt: 'consent'`, `include_granted_scopes: 'true'`, and the existing `scope` config. Call `requestAccessToken({ prompt: '' })` (the empty prompt on `requestAccessToken` is what shows the consent screen, while `prompt: 'consent'` on `initTokenClient` config enables the long-lived scope grant).
- On subsequent sign-ins (userEmail already present), reuse the existing singleton `this.tokenClient` as today.
- Persist `access_token`, `expires_at`, and `user_email` to localStorage in the existing token callback (`googleService.ts:104-126`).

**Patterns to follow:**
- Existing one-shot client pattern in `trySilentRefresh` at `googleService.ts:162-186`.
- Existing `fetchUserInfo()` flow at `googleService.ts:202-216`.

**Test scenarios:**
- Happy path — no prior userEmail in localStorage, `signIn()` invoked → a new `initTokenClient` is created with `prompt: 'consent'` + `include_granted_scopes: 'true'`; `requestAccessToken` is called on the new client.
- Happy path — userEmail already in localStorage, `signIn()` invoked → existing singleton `tokenClient` is used; `initTokenClient` is NOT called again.
- Integration — successful first sign-in response populates all three localStorage keys (`google_access_token`, `google_token_expires_at`, `google_user_email`).

**Verification:**
- Test that spies on `initTokenClient` and asserts the config shape for the first-sign-in call.
- Manual verification: after deploying, a brand-new user sees the consent screen on first sign-in; a returning user does not.

### U4. Lazy silent refresh in `driveJsonStore`

**Goal:** Every Drive request goes through auth state check + silent refresh, matching the guarantee that `googleService` provides for Calendar/Tasks.

**Requirements:** R1, R4.

**Dependencies:** U1, U2.

**Files:**
- Modify: `battle-plan/src/services/driveJsonStore.ts` (the request path at `:239` and any other method that fetches `google_access_token`)
- Test: `battle-plan/src/services/driveJsonStore.test.ts` (existing — add new scenarios)

**Approach:**
- Before each Drive HTTP request, call `googleService.getAuthState()`. If state is `REFRESH_PENDING`, call `googleService.trySilentRefresh()`.
- If refresh succeeds, read the fresh token from `googleService` (not from localStorage — this is the small change in coupling: `driveJsonStore` was reading localStorage directly; now it asks `googleService`).
- If refresh fails, return an error indicating "auth unavailable" to the caller.
- `driveJsonStore` does NOT introduce any new method on `googleService`. It uses only `getAuthState()`, `trySilentRefresh()`, and a way to read the current access token (either via the existing `getAuthStatus()` returning `accessToken`, or via a new tiny getter like `getAccessToken()` — implementation-time).

**Patterns to follow:**
- Existing `driveJsonStore.test.ts:23-39` mock-window pattern.
- Existing `ensureDriveRequestOk` checks at the top of each method in `driveJsonStore.ts`.

**Test scenarios:**
- Happy path — fresh token, Drive call made → request uses token from `googleService`, no refresh attempted.
- Happy path — expired token, silent refresh succeeds → request uses fresh token, original localStorage token is replaced.
- Error path — expired token, silent refresh fails → Drive call returns an "auth unavailable" error; callers (`taskDriveBackup`, `workLogsSync`, `suggestionsSync`, `agentBridge`) receive the error.
- Error path — Drive API returns 401 even after a fresh token → caller receives the error; `signOut()` is NOT called; localStorage is NOT cleared.

**Verification:**
- Existing `driveJsonStore.test.ts` continues to pass.
- New scenarios added pass.

### U5. Suppress alert on `OFFLINE_AUTH` in `useTaskCommands`

**Goal:** When the user taps "Sync" while in `OFFLINE_AUTH` state, no alert appears. The caller silently no-ops or surfaces the soft icon change.

**Requirements:** R4, R5 (UI side of the offline contract).

**Dependencies:** U1, U2.

**Files:**
- Modify: `battle-plan/src/hooks/useTaskCommands.ts:124-135` (`handleSyncToGoogle` alert logic)

**Approach:**
- Replace the generic `catch (error) { alert(...) }` with a typed check: if the error is an `AuthUnavailableError` (or matches the new "auth unavailable" signal), do not `alert()`. Optionally set a transient state that the UI can read to flip the sync icon to "pending/failed".
- The actual icon update logic lives in U6.

**Patterns to follow:**
- Existing try/catch shape in `useTaskCommands.ts:124-135`.

**Test scenarios:**
- Happy path — `handleSyncToGoogle` called with valid auth → sync proceeds, no alert.
- Error path — `handleSyncToGoogle` called when `googleService` returns "auth unavailable" → no alert, no re-prompt, state hook updates.
- Error path — `handleSyncToGoogle` called when a network error occurs → existing alert behavior preserved for non-auth errors.

**Verification:**
- Manual check that tapping Sync during offline mode does not show a popup.
- Test for the suppress-alert path passes.

### U6. Sync icon in Sidebar and mobile header

**Goal:** A small icon visually indicates sync state — in sync / sync pending / sync failed — without text, without popups.

**Requirements:** R5.

**Dependencies:** U1.

**Files:**
- Modify: `battle-plan/src/components/Sidebar.tsx` (add icon, accept new prop for sync state)
- Modify: `battle-plan/src/App.tsx` (pass sync state to both Sidebar and mobile header)

**Approach:**
- Add a small icon next to the existing Settings button in `Sidebar.tsx:79-85` and next to the existing Settings button in `App.tsx:553-558`. Use `lucide-react` icons already in the dependency (e.g., `Cloud` for in-sync, `CloudOff` for sync-failed, `CloudCog` or `Loader2` for pending — final icon choice is implementation-time).
- Prop drilling: `Sidebar.tsx` receives a new prop `syncState: GoogleAuthState`. `App.tsx` derives a sync state value from `googleAuth` + `syncHealth` (e.g., `'ok' | 'pending' | 'failed'`) and passes it down.
- The icon is small (matching existing icon sizing `w-4 h-4`), positioned so it does not visually clash with the AI-active dot or the spin animation on Settings.
- No text, no tooltip, no badge. The visual change is the only signal.

**Patterns to follow:**
- Existing `Settings` icon button shape at `Sidebar.tsx:79-85`.
- Existing `isAiActive` dot at `Sidebar.tsx:69-77`.

**Test scenarios:**
- Visual check — Sidebar renders the icon with the correct variant for each of the three states.
- Visual check — Mobile header renders the same icon.
- Edge case — when sync state is `OFFLINE_AUTH` and a network operation is pending, the icon shows the "pending" variant (since the system is waiting, not failed).

**Verification:**
- Manual visual verification in the browser: change auth state, confirm icon changes accordingly.
- No test framework for React components is currently set up. The test for U6 is manual visual verification plus an integration check that the prop passes through.

### U7. Test runner wiring

**Goal:** The new `googleService.test.ts` runs as part of `npm run test:worklogs`.

**Requirements:** R7.

**Dependencies:** U1, U2, U3, U4, U5.

**Files:**
- Modify: `battle-plan/package.json:10` (append the new test file to the `&&` chain)
- Create: `battle-plan/src/services/googleService.test.ts`

**Approach:**
- Follow the existing pattern from `driveJsonStore.test.ts:1-39` exactly: `/// <reference types="node" />`, `node:test` + `node:assert/strict`, install-window helper that sets `globalThis.window` and `globalThis.localStorage` before each test, with `beforeEach` / `afterEach` cleanup.
- Append `node --experimental-strip-types src/services/googleService.test.ts &&` to `package.json:10` so it runs alongside the existing tests.

**Patterns to follow:**
- `driveJsonStore.test.ts:23-39` (mock-window helper).
- `workLogExtractor.test.ts` for assertion style.

**Test scenarios:**
- The test file imports scenarios from U1, U2, U3, U5 — each test exercises one behavior, no shared state.

**Verification:**
- `npm run test:worklogs` runs all six test files and reports green.

## System-Wide Impact

- **Interaction graph:** the `google-auth-change` CustomEvent is dispatched from `googleService` (4 sites: `:92-95, :122-124, :179-181, :253-255`) and consumed in `App.tsx:170-179`. Plan changes the event payload shape; the single consumer must be updated in lockstep. Any future subscriber must consume the new `{ state, accessToken }` shape.
- **Error propagation:** the new "auth unavailable" signal flows from `googleService` methods → `driveJsonStore` request → callers (`taskDriveBackup`, `workLogsSync`, `suggestionsSync`, `agentBridge`) → `useTaskCommands.handleSyncToGoogle`. The signal is intentionally non-throwing at the service layer so callers can decide between silent fallback (during normal use) and explicit surfacing (during manual sync).
- **State lifecycle risks:** the four-state model means `REFRESH_PENDING` is now a stable intermediate state, not a transient `isSignedIn: false`. Components that previously bailed on `!isSignedIn` must update to handle `REFRESH_PENDING` as "still signed in for our purposes, just attempt a refresh first." This is the highest-risk area of the refactor.
- **API surface parity:** `GoogleAuthStatus` is declared in two places (`googleService.ts:60-63` and `types.ts:11-14`). Both must be updated in lockstep. The plan does NOT consolidate the two declarations in this PR — that is a separate cleanup not blocking this feature.
- **Integration coverage:** the most important end-to-end check is "cold phone launch → silent refresh succeeds or falls to offline with soft icon, no popup." This is not unit-testable without a PWA-installed browser harness. Manual verification on a real device (or PWA-installed Chrome on Android) is required as the final gate.
- **Unchanged invariants:** OAuth scopes (`calendar.events + drive + tasks`) and client ID (`googleClientId` env var) remain unchanged. Existing `signOut()` user-facing behavior (clears localStorage, dispatches auth-change event with `isSignedIn: false`) is preserved — the difference is that auto-clear on 401 is removed, but user-initiated clear still works.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `setTimeout` race in `trySilentRefresh` (`:198`) returns `true` when refresh actually failed, silently letting a stale token through. | U2 fixes the race as part of the lazy refresh implementation. Test scenario in U2 covers it. |
| New event payload shape breaks the single subscriber (`App.tsx:170-179`). | U1 updates both dispatcher and subscriber in lockstep; TypeScript strict mode catches any drift. |
| Eight call sites reading `googleAuth.isSignedIn` may not all be enumerated; one missed site silently breaks. | Repo research enumerated all 24 references. U1 includes verification step: typecheck must pass. |
| `useTaskCommands.handleSyncToGoogle` still shows alert for non-auth errors; if "auth unavailable" is mistakenly typed as a generic error, the alert appears. | U5 introduces explicit type check. Test scenario covers it. |
| Manual visual check on PWA-installed phone cannot be automated in CI; regression risk on mobile. | U6 documents manual verification as the gate. Recommend documenting in PR description with a screenshot. |
| Google may change GIS `prompt: 'consent'` + `include_granted_scopes: 'true'` semantics; documented lifetime guarantee (~12h) may shift. | Origin A1 already records this as an assumption. No code-side mitigation beyond behavior-degrading to offline mode, which is already the design. |

## Documentation / Operational Notes

- `docs/STATUS-progres-report.md:29` lists "Google Auth Persistence" as 95% shipped. After this plan lands, that line should be moved to "Done — Quiet Auth (silent refresh, lazy state, soft icon)" or similar. PR description should mention this.
- A future `ce-compound` learning entry would be valuable: "401 response is not a license to clear local OAuth credentials; silent refresh + offline fallback is the correct pattern." Two specific codifications: (1) the rule itself, (2) "Google silent refresh on PWA-installed phone is best-effort; design auth state to be informational, not gating."
- No CI / GitHub Actions changes. No `.github/workflows/` exists in this repo. The test command is local-only.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-03-quiet-google-auth-for-drive-sync.md](../brainstorms/2026-07-03-quiet-google-auth-for-drive-sync.md)
- Related plan: [docs/plans/2026-07-03-001-refactor-drive-json-store-and-app-shell-plan.md](2026-07-03-001-refactor-drive-json-store-and-app-shell-plan.md) — establishes the `googleService` owns auth invariant
- Related plan: [docs/plans/2026-06-30-003-refactor-runtime-traceability-and-architecture-plan.md](2026-06-30-003-refactor-runtime-traceability-and-architecture-plan.md) — U2 sync and OAuth diagnostic health model consumes auth state
- Status context: [docs/STATUS-progres-report.md:29](../STATUS-progres-report.md) — prior "Silent Refresh" shipping context