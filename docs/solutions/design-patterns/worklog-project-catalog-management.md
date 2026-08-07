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
tags: [worklogs, projects, dexie, transactions, archive, reactive-ui]
---

# Durable WorkLog project catalog

## Context

WorkLog projects were durable database rows, but their lifecycle was hidden inside each project picker. The picker loaded its own snapshot, created projects directly, and archived them from the selection dropdown. Agent Bridge implemented a separate set of name-matching and restoration rules. Those paths could disagree about duplicates, archived projects, and timestamps.

A project such as “Liberec Plaza Banka” needs a longer lifetime than one WorkLog. It should be created once, reused while work continues, archived without losing history, and restored with the same identity if work resumes.

## Guidance

Treat the project catalog as one domain boundary, not as picker state.

- Normalize names in one place and make lookup plus mutation one transaction. The catalog service returns explicit outcomes for create, duplicate, archived match, restore, conflict, and validation instead of making callers infer what happened (`battle-plan/src/services/projectCatalog.ts:83`).
- Use soft archival. New records can select only active projects, while existing WorkLogs keep their snapshotted project name. The durable Project and WorkLog fields are defined separately (`battle-plan/src/db.ts:46`, `battle-plan/src/db.ts:58`).
- Make UI consumers reactive to persisted state. The management surface and picker observe the project table, so create, archive, restore, and color changes appear without remounting (`battle-plan/src/components/worklogs/ProjectManager.tsx:41`, `battle-plan/src/components/worklogs/ProjectPicker.tsx:37`).
- Validate the project in the same transaction that writes a new WorkLog. Batch voice input validates every project before adding any row, so one stale selection aborts the whole batch (`battle-plan/src/services/workLogPersistence.ts:40`).
- Preserve an unchanged historical assignment during edit. Require an active project only when the assignment changes (`battle-plan/src/services/workLogPersistence.ts:74`).

An archived normalized-name match is not silently treated as a new project. Human-facing creation asks for confirmation before restoring the original row. An explicit Agent Bridge create action already carries that intent. If old data contains multiple normalized matches, the catalog reports a conflict and does not guess, merge identities, or rewrite WorkLogs.

## Why This Matters

Keeping lifecycle logic in one transaction boundary prevents two callers from creating normalized duplicates and closes the gap where a project could be archived between validation and WorkLog persistence. Explicit outcomes also keep UI feedback and Agent Bridge behavior aligned.

The denormalized project name on each WorkLog is intentional historical data. It keeps reports readable when a project is archived, missing, or imported from another device whose numeric project ID collides with a different local row. Numeric IDs are therefore not sufficient to identify an imported selection; the stored name must agree too.

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
