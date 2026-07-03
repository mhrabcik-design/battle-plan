# Quiet Google Auth for Drive Sync

**Status:** Draft
**Date:** 2026-07-03
**Owner:** martin
**Scope:** Single feature within Battle Plan PWA

## Problem

Today, every cold start of the Battle Plan PWA on a phone surfaces a Google sign-in prompt, even when the user signed in hours earlier. The current implementation calls `signOut()` whenever an API request returns `401 UNAUTHENTICATED`, which clears `localStorage` tokens and forces a fresh `requestAccessToken({ prompt: '' })` on the next launch. On mobile (especially in PWA-installed mode), Google's silent refresh via `prompt: 'none'` fails frequently because the browser has no Google session cookie. The result is a steady drip of unexpected authentication prompts that interrupt the user's flow.

The user is not asking for a new auth model. They are asking to **stop being interrupted**. Whatever change is made must preserve the local-first product identity (no server-side dependency, offline-capable, single-user).

## User-Visible Behavior (Target)

1. **First-time sign-in** remains a single explicit flow with a consent screen. After the user clicks "Sign in with Google" and approves the consent, they are signed in.
2. **Subsequent sign-ins** are invisible. The app silently refreshes the access token in the background. The user does not see a Google popup unless *they* initiate an action that requires it.
3. **When the token cannot be refreshed** (e.g. cold phone with no Google session cookie, long offline period, user revoked access from Google account page), the app continues to work against local IndexedDB. Sync is deferred — not blocked. Changes made locally accumulate and merge on the next successful refresh.
4. **Indication of sync state** is a small icon next to the existing Sync control. Three visual states: "in sync" (current look), "sync pending" (subtle change — color shift or dot), "sync failed" (same — no popup, no toast).
5. **No popups, no toasts, no banners** for auth state changes during normal use. The user opts in to re-auth by tapping "Reconnect Google" in Settings, which is the only place a manual sign-in trigger lives.
6. **Offline-first stays intact.** The app must remain fully usable without a network connection. Drive sync is a feature layered on top, not a precondition.

## Functional Requirements

### FR1 — Lazy silent refresh before Drive API calls

Every public Google API method on `GoogleService` (task list, tasks, calendar events, drive files) must, before executing the actual request:

1. Call `getAuthStatus()`.
2. If the status reports `isSignedIn: true` and the token has more than 60 seconds of lifetime remaining, proceed.
3. If the status reports `isSignedIn: false` (token expired or absent in memory), call `trySilentRefresh()`.
4. If silent refresh returns `true`, retry `getAuthStatus()` and proceed if now signed in.
5. If silent refresh returns `false`, the method returns an "auth unavailable" result (caller decides how to handle). It must NOT call `signOut()` and must NOT clear `localStorage`.

The current code already calls `signOut()` on `401 UNAUTHENTICATED` in calendar methods. That behavior must be removed. A `401` response is a signal that the token is bad, not a license to delete local credentials.

### FR2 — Extended lifetime at first sign-in

The first sign-in (when `localStorage.google_user_email` is empty) must use:

```
prompt: 'consent'
include_granted_scopes: 'true'
```

This causes Google to issue an access token with longer real-world lifetime (~12 hours instead of ~1 hour) at the cost of one extra consent screen at first sign-in. Existing tokens (already cached in `localStorage`) are not affected — only the moment of first sign-in per browser.

Subsequent silent refresh attempts use `prompt: 'none'` as today.

### FR3 — Token state is decoupled from sign-in intent

A new logical state must replace today's boolean "isSignedIn":

- `SIGNED_IN` — fresh token, ready for Drive calls.
- `REFRESH_PENDING` — token present in `localStorage` but stale or unverified; next Drive call will silently refresh.
- `OFFLINE_AUTH` — no usable token; Drive calls return an "auth unavailable" signal; app continues working against local data.
- `SIGNED_OUT` — user explicitly signed out (existing `signOut()` behavior); no token in `localStorage`.

The state `REFRESH_PENDING` is new. Today, an expired token is reported as `isSignedIn: false`, which downstream code interprets as "user must sign in again." Under the new model, `REFRESH_PENDING` means "we have a stored token, attempt silent refresh before bothering the user."

### FR4 — Sync icon with three visual states

The sync control in the main UI (currently rendered in the Sidebar and Settings modal) must visually distinguish:

- In sync (default): current look.
- Sync pending (refresh attempt in progress or about to be attempted): color shift or small dot, no animation.
- Sync failed (refresh attempted and failed): same — soft indicator, no text.

The exact visual treatment is delegated to implementation. The requirement is: **the user can tell at a glance whether sync is alive, without reading any text or seeing any popup.** Implementation must respect the existing UI patterns; this is a small visual addition, not a redesign.

### FR5 — Manual re-auth lives in Settings

The existing "Sign in with Google" / "Disconnect" affordances remain in Settings. They are the only paths that trigger an interactive Google popup. Tapping "Reconnect Google" is the equivalent of the first-time sign-in flow (FR2 applies).

### FR6 — All current capabilities preserved

- Calendar event creation, update, deletion must continue to work for the signed-in user.
- Drive file read (for `bp_suggestions.json` etc.) must continue to work.
- Tasks list read/write must continue to work.
- Existing offline behavior (use local data when Drive sync is unavailable) must continue to work and must not regress.

## Non-Goals

- **No server-side OAuth proxy.** The product is local-first; introducing a backend contradicts that.
- **No background timer** that polls for token refresh every N minutes. Battery and data cost without solving the real failure mode (no Google cookie on cold phone).
- **No new OAuth scopes.** Scope set stays at `calendar.events + drive + tasks`.
- **No toast, banner, or modal** for auth state. The user explicitly chose the quietest indicator option.
- **No analytics / event tracking** for auth state changes.
- **No migration of existing users' tokens.** The first launch after this change will see the user's existing `localStorage` token (which behaves as `REFRESH_PENDING`); if it is still valid, silent refresh succeeds and the user never notices the change.

## Dependencies and Assumptions

- **A1.** Google's GIS `initTokenClient` with `prompt: 'consent'` + `include_granted_scopes: 'true'` issues an access token with real-world lifetime up to ~12 hours. (Documented but not guaranteed by Google.)
- **A2.** On a phone in PWA-installed mode, `trySilentRefresh` (with `prompt: 'none'`) will fail frequently because the browser lacks a Google session cookie. This is the failure mode the new design assumes and accepts.
- **A3.** All current call sites of `GoogleService` (Sidebar, SettingsModal, useDriveSyncOrchestration, workLogsSync, taskDriveBackup, agentBridge) tolerate a non-throwing "auth unavailable" return value. Verification during implementation: audit every caller and update if any of them currently throw on auth failure in a way that would surface as a popup.
- **A4.** Local Dexie storage accumulates changes correctly during offline periods and merges them on the next successful sync. This is the existing behavior and is assumed not to regress.

## Risks

- **R1 — Silent refresh never succeeds.** If the user's phone never has a valid Google cookie, sync is permanently deferred until they manually reconnect. Mitigation: the soft indicator makes the state visible; the Settings page explains how to reconnect.
- **R2 — 401 handling regression.** The current code calls `signOut()` on `401`. Removing it could mask a real auth bug. Mitigation: log `401` events explicitly so a future debug session can distinguish "token bad, refresh failed" from "user revoked access."
- **R3 — UX confusion.** Users who never see a popup may forget they have a Google connection at all. Mitigation: Settings page shows connection status clearly.
- **R4 — Scopes drift.** If a future scope is added without re-consent, the new scope request may silently fail. Mitigation: out of scope for this feature; treat as a separate "scope audit" task.

## Success Criteria

- **SC1.** A user who signed in once on a phone and uses the app actively for the next 7 days sees at most one Google sign-in prompt — and only if they explicitly tap "Reconnect Google" in Settings.
- **SC2.** A user who closes the app, opens it again the next day, makes a change to a task, and taps Sync: the change syncs without a popup *if* silent refresh succeeds. If silent refresh fails, the change is queued locally and the sync icon shows the "pending" state.
- **SC3.** A user who has been offline for 48 hours and reconnects: their accumulated local changes merge with Drive on the next sync, with no data loss. No popup is shown unless the silent refresh fails.
- **SC4.** The new code path is observable in tests: a `mockGoogleService` showing expired token → `trySilentRefresh` called before Drive API call → either success (call proceeds) or graceful "auth unavailable" return (no `signOut()` side effect).

## Open Questions

None. All product decisions resolved during brainstorm.

## Out of Scope for This Product's Identity

A server-side OAuth proxy (Approach C from the brainstorm) was considered and rejected because it would shift the product from local-first PWA to hybrid client-server, which contradicts existing positioning (see ADR-007 "Offline-First PWA" — though that ADR is not yet committed, the principle is reflected across the codebase and the existing graph-DB and IndexedDB architecture). If the product later chooses to make that shift, this feature becomes obsolete and a redesign is required.