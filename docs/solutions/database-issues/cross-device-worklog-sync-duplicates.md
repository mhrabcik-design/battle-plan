---
title: Cross-device WorkLog sync duplicates
date: 2026-08-11
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
tags: [worklogs, drive-sync, dexie, portable-identity, duplicate-repair]
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
- Deleting only the local copies is not sufficient. The normal backup flow pulls Drive before it pushes and can immediately import those copies again.

## Solution

Legacy identity backfill now derives a synchronous deterministic ID from the stable WorkLog content. When several legitimate legacy rows have identical content in one database, a deterministic occurrence suffix keeps their identities distinct. The backfill stays synchronous so the IndexedDB upgrade transaction cannot close while awaiting external asynchronous hashing.

Existing rows that already received different random identities are handled as repair candidates, not automatic deletions:

1. The WorkLogs page finds groups with the same canonical project and persisted work content.
2. It shows the candidate group and does nothing until the user confirms.
3. The repair service revalidates the exact row IDs inside one Dexie transaction.
4. It keeps the newest row and removes only the previewed copies.
5. The following sync pulls unrelated cloud changes while excluding the confirmed copy identities, then publishes the converged clean snapshot to Drive.
6. If the preview changed because of an edit or sync, the transaction fails without a partial deletion.

The defining implementation is split between `battle-plan/src/utils/workLogSyncIdentity.ts`, `battle-plan/src/services/workLogDuplicateRepair.ts`, and `battle-plan/src/pages/WorkLogsPage.tsx`.

## Why This Works

Deterministic legacy IDs give the same historical row the same portable identity on independent devices, which prevents future multiplication. Occurrence suffixes preserve separate same-content legacy rows. Explicit confirmation is required for older randomized rows because their stored data contains no durable provenance that can distinguish a cross-device clone from intentionally repeated work.

The repair-aware sync exclusion is part of the contract. An ordinary pull-then-push sync would restore the removed cloud copies before the cleaned snapshot reached Drive, while a blind overwrite could discard unrelated work created on another device.

## Prevention

- Never create shared logical identity with a random value inside a per-device migration.
- Keep identity backfills synchronous inside IndexedDB upgrade callbacks.
- Test legacy upgrades on two independent databases and compare the resulting portable IDs.
- Preserve two intentionally identical WorkLogs in migration and sync regression tests.
- Treat content equality as a repair candidate. Require explicit confirmation before destructive cleanup when provenance is ambiguous.
- Revalidate the preview in the same transaction that performs deletion.

## Related Issues

- [WorkLog project catalog management](../design-patterns/worklog-project-catalog-management.md)
- [Durable agent protocol ledger](../architecture-patterns/durable-agent-protocol-ledger.md)
