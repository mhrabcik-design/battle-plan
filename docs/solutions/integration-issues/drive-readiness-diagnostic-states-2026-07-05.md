---
title: Drive Readiness Must Stay Separate from Google OAuth Health
category: integration-issues
module: Drive sync diagnostics
date: 2026-07-05
problem_type: integration_issue
component: drive-sync
severity: medium
symptoms:
  - "Google Auth diagnostic card was OK while Tasks, WorkLogs, and Suggestions sync cards showed generic STALE states"
  - "Missing optional Drive JSON files looked like sync failures"
  - "WorkLogs and Suggestions could remain uninitialized on a clean Drive account until another service created /Anu-BattlePlan/"
root_cause: readiness_state_collapse
resolution_type: code_fix
related_components:
  - drive_json_store
  - sync_diagnostics
  - worklogs_sync
  - suggestions_sync
tags:
  - google-auth
  - drive-sync
  - diagnostics
  - first-run
  - optional-files
---

# Drive Readiness Must Stay Separate from Google OAuth Health

## Problem

The diagnostics UI treated OAuth health and Drive readiness as if they were the same thing. `Google Auth` could be OK because the user had a usable token, while Drive-backed sync still needed `gapi.client.drive`, the `/Anu-BattlePlan/` folder, and optional JSON files such as `battle_plan_data.json`, `work_logs_data.json`, and `agent-suggestions.json`.

When any of those Drive-specific pieces were missing, the UI collapsed multiple normal or recoverable states into `STALE`. That made a clean first-run Drive account look broken.

## Solution

`battle-plan/src/services/driveJsonStore.ts` now exposes structured readiness through `initWithStatus()` and `lastStatus`, while preserving the old boolean `init()` API for existing callers. It also exposes `readJsonFileWithStatus()` so callers can tell the difference between a missing optional file, an unavailable store, and a failed media read.

The domain services translate those store-level states into domain results:

- `taskDriveBackup.loadDetailed()` distinguishes loaded backup, missing file, store unavailable, and error.
- `workLogsSync.loadAllDetailed()` distinguishes loaded data, missing file, store unavailable, and error while keeping `loadAll()` compatible.
- `suggestionsSync.fetchSuggestionsDetailed()` distinguishes loaded suggestions, missing file, store unavailable, and error while keeping `fetchSuggestions()` compatible.

WorkLogs and Suggestions now initialize Drive with `createFolder: true`, matching Tasks backup. The hooks use the detailed results to show first-run missing files as idle/empty states instead of unexplained stale states.

## Why This Works

OAuth answers only "can we try Google APIs?" Drive readiness answers "can this specific Drive storage contract run?" Keeping those states separate lets diagnostics tell the user whether they need to reconnect Google, wait for Drive client initialization, create seed data, or investigate a real API failure.

Missing optional files are normal on first use. They should not be conflated with Drive initialization failure.

## Prevention

For every future Drive-backed service, expose three separate outcomes at the boundary:

1. Store unavailable: Drive client/auth/folder is not ready.
2. File missing or empty: first-run or no external agent data yet.
3. Error: an operation failed and should set `lastError`.

Then map those outcomes into `SyncHealth` at the hook/UI boundary instead of deriving diagnostic states from `null` or `[]` alone.
