---
title: Cross-device WorkLog sync duplicates
date: 2026-08-11
last_updated: 2026-08-12
category: database-issues
module: WorkLogs
problem_type: database_issue
component: database
symptoms:
  - "One WorkLog appears several times after desktop and phone sync"
  - "Daily totals multiply even though every visible row has the same work content"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [worklogs, drive-sync, dexie, portable-identity, duplicate-repair, tombstones, etag]
---

# Cross-device WorkLog sync duplicates

## Problem

A single historical WorkLog could become several rows after the same legacy database was opened and synchronized on multiple devices. The calendar then counted every copy, for example showing four records and 120 hours instead of one record and 30 hours.

## Symptoms

- The rows have the same date, project, people, hours, source, and creation metadata.
- The rows differ only in device-assigned `syncId`, `publicId`, and local Dexie `id` values.
- A project merge makes the copies easier to notice because all historical project aliases render under one canonical project.

## What Didn't Work

- Assigning `crypto.randomUUID()` during a database upgrade is not a portable identity. Each device gives the same pre-existing row a different identity, so Drive sync treats every copy as new.
- Automatically deleting rows with the same content is unsafe. Two confirmed rows from one voice batch can intentionally have identical fields and timestamps while retaining distinct sync identities.
- Deleting only the local copies is not sufficient. The normal backup flow can import them again from Drive or from a stale phone or tab.
- Keeping deletion metadata only in `work_logs_data.json` is not sufficient. An older client can replace that full snapshot without preserving the new field.
- Trashing non-canonical same-name Drive files after reading them is unsafe. A stale client can still write unrelated data to one of those files between the read and cleanup.

## Solution

Legacy identity backfill now derives a synchronous deterministic ID from the stable WorkLog content. When several legitimate legacy rows have identical content in one database, a deterministic occurrence suffix keeps their identities distinct. The backfill stays synchronous so the IndexedDB upgrade transaction cannot close while awaiting external asynchronous hashing.

Existing rows that already received different random identities are handled as repair candidates, not automatic deletions:

1. The WorkLogs page finds groups with the same canonical project and persisted work content.
2. It shows the candidate group and does nothing until the user confirms.
3. The repair service revalidates the exact row IDs inside one Dexie transaction.
4. In the same transaction, it writes one deletion tombstone for every removed portable `syncId` and then removes only the previewed copies.
5. If the same tombstone already exists, repair reuses it. A conflicting survivor or fingerprint aborts the transaction.
6. If the preview changed or any tombstone write fails, the transaction rolls back without a partial deletion.

The durable deletion record is `WorkLogDeletionTombstone` and database version 18 adds its store keyed by the removed `syncId` (`battle-plan/src/db.ts:102`, `battle-plan/src/db.ts:618`). The confirmation transaction spans WorkLogs and tombstones (`battle-plan/src/services/workLogDuplicateRepair.ts:54`).

Drive synchronization treats these tombstones as a monotonic journal:

1. Current clients read both the ordinary WorkLogs payload and the separate `work_log_deletion_tombstones.json` file (`battle-plan/src/services/workLogsSync.ts:145`).
2. Tombstones with the same deleted `syncId` are merged. Conflicting survivor, fingerprint, or reason values fail closed (`battle-plan/src/services/workLogsSync.ts:87`).
3. The journal is written before the mutable WorkLogs snapshot. Existing files use `If-Match`; a `412` causes a fresh pull-and-merge retry.
4. The ETag returned by each successful upload is retained for the next conditional write (`battle-plan/src/services/workLogsSync.ts:245`, `battle-plan/src/services/workLogsSync.ts:268`).
5. Pull removes already-local rows with tombstoned `syncId` values and skips matching cloud rows before normal merge (`battle-plan/src/services/workLogsSync.ts:351`, `battle-plan/src/services/workLogsSync.ts:484`).
6. Push excludes tombstoned identities from the full WorkLogs snapshot (`battle-plan/src/services/workLogsSync.ts:591`).

The exported cloud-to-local and local-to-cloud merge operations share one in-client queue (`battle-plan/src/services/workLogsSync.ts:301`). The Drive store paginates every same-name file, and WorkLogs sync merges all of them instead of trashing duplicates that an older client may still target (`battle-plan/src/services/driveJsonStore.ts:451`, `battle-plan/src/services/workLogsSync.ts:147`).

## Why This Works

Deterministic legacy IDs give the same historical row the same portable identity on independent devices, which prevents future multiplication. Occurrence suffixes preserve separate same-content legacy rows. Explicit confirmation is required for older randomized rows because their stored data contains no durable provenance that can distinguish a cross-device clone from intentionally repeated work.

A tombstone turns a confirmed deletion into durable data instead of relying on row absence. Once a current client learns the tombstone, the deleted portable identity is suppressed before add/update merge can resurrect it. The journal is stored independently of the mutable snapshot, so a client that overwrites only `work_logs_data.json` does not overwrite the journal. The compatibility copy inside the main payload helps current clients converge.

Tombstone-first conditional writes ensure the protective fact is durable before the mutable snapshot is updated. ETag conflicts force a re-read instead of overwriting a concurrent revision. Retaining duplicate same-name Drive files avoids discarding data that a stale client wrote after the last read.

The contract remains intentionally narrow: only user-confirmed exact-copy repair creates these tombstones. Historical `projectName` snapshots are not rewritten, and ambiguous or contradictory deletion identity fails closed.

## Prevention

- Never create shared logical identity with a random value inside a per-device migration.
- Keep identity backfills synchronous inside IndexedDB upgrade callbacks.
- Test legacy upgrades on two independent databases and compare the resulting portable IDs.
- Preserve two intentionally identical WorkLogs in migration and sync regression tests.
- Treat content equality as a repair candidate. Require explicit confirmation before destructive cleanup when provenance is ambiguous.
- Revalidate the preview in the same transaction that performs deletion.
- Persist every confirmed deletion as a monotonic tombstone keyed by portable identity. Row absence alone is not a sync protocol.
- Keep the deletion journal separate from a legacy full snapshot that old clients can overwrite.
- Write the deletion journal before the mutable snapshot, retain the returned ETag, and retry only after a fresh pull on precondition conflict.
- Read and merge every same-name Drive file. Do not trash a duplicate without a conflict-safe proof that no client can still write to it.
- Test stale-device resurrection, repeated repair, contradictory tombstones, partial journal/snapshot writes, overlapping backups, and direct database upgrade from the previous version.

## Related Issues

- [WorkLog project catalog management](../design-patterns/worklog-project-catalog-management.md)
- [Durable agent protocol ledger](../architecture-patterns/durable-agent-protocol-ledger.md)
- [Durable suggestion decision registry](../architecture-patterns/durable-suggestion-decision-registry.md)
