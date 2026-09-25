---
title: Ordinary WorkLog deletion must survive stale Drive snapshots
date: 2026-09-25
category: database-issues
module: WorkLogs
problem_type: database_issue
component: database
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [worklogs, deletion, tombstones, immutable-snapshots, drive-sync]
---

# Ordinary WorkLog deletion must survive stale Drive snapshots

## Problem

Duplicate repair already persisted deletion tombstones, but ordinary UI and agent deletion removed only the local row. The next Drive pull, including the preliminary pull inside an upload, reimported the old row. An immutable snapshot intentionally retains history, so absence in a new snapshot cannot express deletion.

## Solution

`services/workLogDeletion.ts` exposes `deleteWorkLog(id)`. It reads the selected row, records a `user-deleted` tombstone keyed by its existing portable `syncId`, and removes the row in one IndexedDB transaction. A missing identity, contradictory existing tombstone, or failed write aborts the deletion. A repeated request for an absent local row is a no-op. Callers with an enclosing transaction must include both `workLogs` and `workLogDeletionTombstones`.

The tombstone type distinguishes ordinary deletion from `confirmed-duplicate` repair. Ordinary deletion has no survivor or content fingerprint: selecting one row must not delete other intentionally identical work. Both variants use the existing indexed store, monotonic journal, and sync suppression by `syncId`; no database migration is needed. Conflicting reasons, survivors, or fingerprints continue to fail closed.

The separate Drive journal is published and verified before the immutable WorkLogs snapshot. Reads still support historical snapshots without tombstones and old duplicate-repair tombstones. Older clients that do not understand `user-deleted` can reject the new journal; all cooperating clients need this update for continued sync. The deletion remains durable for updated clients even if an old client publishes a stale row.

## Verification

Two sync regressions first failed with `WorkLog tombstone nemá platný formát`. The focused deletion, sync, and duplicate-repair suites then passed 43/43 tests, including:

- Atomic rollback on journal-write and row-delete failures.
- A local ordinary deletion surviving the upload's preliminary legacy snapshot pull.
- Remote deletion suppressing stale rows, even with newer edit timestamps.
- Preservation of separate rows with identical content.
- Contradictory deletion metadata rejecting the entire merge.
- Journal-first publication and withholding the WorkLogs snapshot if the journal cannot be verified.
- Existing exact-copy repair behavior.

## Related guidance

[Immutable Drive snapshots](../integration-issues/worklogs-immutable-drive-snapshots.md) is the current publication contract. The older [duplicate repair note](cross-device-worklog-sync-duplicates.md) describes the original narrow scope and historical ETag strategy; ordinary deletion now also produces tombstones, and create-only verified snapshots have superseded mutable ETag writes.
