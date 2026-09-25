---
title: Keep task backup independent of the visible view
date: 2026-09-18
category: architecture-patterns
module: Task Drive backup
problem_type: architecture_pattern
component: drive-sync
severity: high
applies_when:
  - "Changing task queries, lazy routes, or automatic Drive backup scheduling"
tags: [drive-sync, task-backup, hydration, concurrency, view-lifecycle]
---

# Keep task backup independent of the visible view

## Context

The planning uplift exposed a persistence dependency hidden in presentation code:
the old automatic task backup effect observed a hash of the currently visible
tasks, but uploaded all tasks and settings. A background edit while viewing
WorkLogs could therefore remain unobserved, while changing views could schedule
an unchanged full upload. Foreground edit-and-save checks did not expose this.

The implementation in this branch is locally verified and pending merge.

## Guidance

Observe the same domain that the backup publishes. The task snapshot reader in
`battle-plan/src/utils/taskBackupRevision.ts` reads tasks and allowlisted portable settings in one
transaction. Its revision includes every serialized field, even when a writer
did not advance `updatedAt`. Do not replace it with visible rows, row counts, or
a maximum timestamp without proving every backup-relevant mutation is covered.

Keep the shell-level observer separate from route queries. In
`battle-plan/src/hooks/useTaskBackup.ts`, a live query supplies the snapshot to
the coordinator. Navigation is not a persistence event.

The coordinator in `battle-plan/src/hooks/taskBackupCoordinator.ts` acknowledges
the revision it actually saved. A later revision stays pending. A write that
outlives its hook still owns the shared write slot until it settles, so a new
hook instance cannot race that request. Stopping a hook suppresses future work
and UI callbacks; it cannot undo an HTTP request already sent.

Initial hydration is another boundary: a successful download is insufficient.
The imported data must finish merging before automatic upload is enabled. A
confirmed missing remote file is a valid first-run result; a failed read or
merge is not. This readiness protects startup only: a later failed pull does
not revoke an earlier successful hydration.

## Why This Matters

These rules prevent local lifecycle races; the coordinator is shared within one
JavaScript application instance, not across browser tabs or devices. As of
2026-09-25, remote concurrency is handled separately by
[immutable task snapshots](../integration-issues/tasks-immutable-drive-snapshots.md).
Treating a local lock as remote concurrency control would recreate a data-loss risk.

Do not copy the WorkLogs publication format into Tasks casually. The existing
immutable-snapshot design also needs domain-specific identity, deletion,
ambiguity and verification rules.

## When to Apply

- Refactoring the app shell, filters or lazy page boundaries.
- Optimizing backup reads or adding another automatic backup trigger.
- Extending task synchronization to a new remote publication protocol.

## Examples

The regression tests in `battle-plan/src/hooks/useTaskBackup.test.ts` cover a
change during an in-flight write, retry after failure, teardown, shared write
exclusion and hydration ordering. `battle-plan/src/utils/taskBackupRevision.test.ts`
checks content and settings changes independent of view or row order.

## Related

- [Lazy page lifecycle boundaries](lazy-page-lifecycle-boundaries.md)
- [WorkLogs immutable Drive snapshots](../integration-issues/worklogs-immutable-drive-snapshots.md)
- [Drive media reads without an ETag](../integration-issues/drive-json-media-read-loses-etag.md)
