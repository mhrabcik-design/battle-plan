---
title: Drive Cache Ownership Must Follow the Verified Google Session
module: Drive sync
date: 2026-10-09
problem_type: integration_issue
component: drive-sync
severity: high
symptoms:
  - "A second Google login reused the previous account's cached Drive folder"
  - "Late reads could restore old file IDs or publish old payloads after an account switch"
  - "A new account refresh shared the previous account's pending request"
root_cause: async_timing
resolution_type: code_fix
tags: [google-auth, drive-sync, account-ownership, cache, async-session]
---

# Drive Cache Ownership Must Follow the Verified Google Session

## Problem

The browser remains mounted when a user signs out, changes Google account, or grants consent again. A service's initialization flag therefore cannot prove that its folder, file IDs or pending operations belong to the current login. Both accounts can be signed in successfully while a stale asynchronous callback continues.

This fix is local and pending deployment. Controlled tests reproduce account switching against the actual services and UI callbacks; they do not establish live OAuth or multi-device transport behavior.

## Root cause

`battle-plan/src/services/driveJsonStore.ts` previously reused an ownerless persistent folder key and an account-independent readiness flag. Domain services also retained file IDs and shared pending promises. Clearing only the store cache would leave logical read → merge → write chains free to continue under a replacement account.

Matching the email at completion is insufficient: A → B → A, logout and new consent can end with the same email. The existing Google authentication generation distinguishes these sessions. A stored email is a login hint, not verified account ownership.

## Solution and rationale

The persistent folder cache is namespaced by the verified account. The legacy ownerless key is ignored and the folder is rediscovered; assigning that old key to whichever account happens to sign in would invent its owner. Reusing an account's own folder after reload remains supported.

In-memory state and each asynchronous operation also capture the authentication session through `battle-plan/src/services/googleAccountSession.ts`. A replacement session invalidates readiness, JSON caches, cached file IDs and pending-read sharing. Old promise cleanup clears only its own reservation, so it cannot remove a newer request.

The guard belongs around the whole operation, including local effects and subsequent requests:

```ts
const session = captureGoogleAccountSession();
const loaded = await readRemote();
session.assertCurrent();
await mergeRemote(loaded, session.assertCurrent);
session.assertCurrent();
await publishMergedState();
session.assertCurrent();
```

The domain services fence each continuation. Drive import and publication-marker transactions also check before commit, allowing Dexie to roll back a changed session. UI effects discard old callbacks, restart on token changes, and check ownership before applying settings, displaying loaded data, or following a voice upload with a reply.

The local database retains its existing shared/offline semantics. This repair prevents an operation begun under A from continuing under B; it does not define per-account local workspaces or authorize migrating or deleting local data. A newly started, current-session synchronization still uses the existing domain merge rules.

Already dispatched external requests cannot be undone. The guarantee is that their late results cannot establish readiness or success, and cannot dispatch the next request under a replacement login. Ordinary teardown within the same login still acknowledges agent mutations already committed; identity loss prevents that acknowledgement.

## Verification and prevention

Regressions cover account-owned persistent cache, independent new-session reads, late folder/media results, logout, A → B → A, read-to-write fences, transactional rollback and UI continuations. Tests preserve normal cache hits, overlapping refresh deduplication and same-session acknowledgement after teardown.

When adding a Drive caller, inspect every await between reading remote state and its final local/UI or remote effect. A transport-level guard alone cannot protect a caller that begins a new request with an old payload. Keep missing optional files distinct from unavailable authentication and request errors.
