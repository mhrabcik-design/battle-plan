---
title: Durable WorkLog project catalog
date: 2026-08-08
category: design-patterns
module: WorkLogs
problem_type: design_pattern
component: service_object
severity: medium
applies_when:
  - "A durable entity is selected repeatedly by new records"
  - "Archived entities must remain readable in historical records"
  - "UI and agent callers must share lifecycle and validation rules"
tags: [worklogs, projects, dexie, transactions, migration, archive, reactive-ui]
---

# Durable WorkLog project catalog

## Context

WorkLog projects were durable database rows, but their lifecycle was hidden inside each project picker. The picker loaded its own snapshot, created projects directly, and archived them from the selection dropdown. Agent Bridge implemented a separate set of name-matching and restoration rules. Those paths could disagree about duplicates, archived projects, and timestamps.

A project such as “Liberec Plaza Banka” needs a longer lifetime than one WorkLog. It should be created once, reused while work continues, archived without losing history, and restored with the same identity if work resumes.

## Guidance

Treat the project catalog as one domain boundary, not as picker state.

- Normalize names in one place and make lookup plus mutation one transaction. One normalized name is one domain identity, including legacy rows that differ only by spacing, case, local ID, or color (`battle-plan/src/utils/projectIdentityReconciliation.ts`).
- Use soft archival. New records can select only active projects, while existing WorkLogs keep their snapshotted project name. The durable Project and WorkLog fields are defined separately (`battle-plan/src/db.ts:46`, `battle-plan/src/db.ts:58`).
- Make UI consumers reactive to persisted state. The management surface and picker observe the project table, so create, archive, restore, and color changes appear without remounting (`battle-plan/src/components/worklogs/ProjectManager.tsx:27`, `battle-plan/src/components/worklogs/ProjectPicker.tsx:33`). Restore confirmations bind to the captured project ID, not a second name lookup.
- Validate the project in the same transaction that writes a new WorkLog. Batch voice input validates every project before adding any row, so one stale selection aborts the whole batch (`battle-plan/src/services/workLogPersistence.ts:47`).
- Preserve an unchanged historical assignment during edit. Require an active project only when the assignment changes (`battle-plan/src/services/workLogPersistence.ts:86`). Agent updates use this same boundary and preserve the WorkLog sync identity.
- Reconcile legacy collisions atomically. Prefer an active row, then the newest row, relink matching WorkLogs to that ID, and remove redundant catalog rows. The v10 Dexie upgrade repairs existing devices, and Drive sync repeats the invariant for imported data (`battle-plan/src/db.ts`, `battle-plan/src/services/workLogsSync.ts`).
- Group reports through the same normalized identity. Calendar dots and table totals must not use raw `projectName` or a name-plus-color pair as their uniqueness key (`battle-plan/src/utils/workLogProjectGrouping.ts`).

An archived normalized-name match is not silently treated as a new project. Human-facing creation asks for confirmation before restoring the original row. An explicit Agent Bridge create action already carries that intent. Legacy duplicates are data corruption, not distinct projects, so the v10 upgrade repairs them once and Drive sync repairs identities after imported changes. Normal catalog mutations can then stay proportional to the small project table.

## Why This Matters

Keeping lifecycle logic in one transaction boundary prevents two callers from creating normalized duplicates and closes the gap where a project could be archived between validation and WorkLog persistence. Explicit outcomes also keep UI feedback and Agent Bridge behavior aligned. Deterministic Agent Bridge rejections are terminal acknowledgements; only transient storage or transport failures should be retried.

The denormalized project name on each WorkLog is intentional historical data. Reconciliation changes the catalog ID but preserves that snapshot. Reports normalize the snapshot only for grouping and use the canonical catalog row for the displayed name and color. Numeric IDs remain device-local and are not sufficient for cross-device matching.

## When to Apply

- A form repeatedly selects a long-lived catalog entity.
- The entity can become inactive while old records must remain readable.
- Multiple entry paths, such as manual UI, voice input, and agents, write the same domain data.
- A read-then-write validation must remain true at commit time.

## Examples

For a new WorkLog, send the proposed project ID and name to the shared persistence boundary. It reloads the active project inside the transaction and writes the catalog name as the snapshot. Do not add directly to the WorkLog table after a separate project lookup.

For an edit, pass no new selection when the historical assignment is unchanged. If the user chooses another project, validate that new ID and name pair as active inside the update transaction.

## Related

- [Batch WorkLog person-hour extraction](./worklog-batch-person-hour-extraction.md)
- [Drive readiness diagnostic states](../integration-issues/drive-readiness-diagnostic-states-2026-07-05.md)
