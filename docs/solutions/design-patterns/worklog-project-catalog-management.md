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
  - "A user must explicitly collapse two semantically equivalent identities"
tags: [worklogs, projects, aliases, dexie, transactions, migration, archive, drive-sync, reactive-ui]
---

# Durable WorkLog project catalog

## Context

WorkLog projects were durable database rows, but their lifecycle was hidden inside each project picker. The picker loaded its own snapshot, created projects directly, and archived them from the selection dropdown. Agent Bridge implemented a separate set of name-matching and restoration rules. Those paths could disagree about duplicates, archived projects, and timestamps.

A project such as “Liberec Plaza Banka” needs a longer lifetime than one WorkLog. It should be created once, reused while work continues, archived without losing history, and restored with the same identity if work resumes.

## Guidance

Treat the project catalog as one domain boundary, not as picker state.

- Normalize names in one place and make lookup plus mutation one transaction. Canonical names and aliases share one reserved identity namespace, including legacy rows that differ only by spacing, case, local ID, or color (`battle-plan/src/utils/projectIdentityReconciliation.ts`).
- Use soft archival. New records can select only active projects, while existing WorkLogs keep their snapshotted project name. The durable Project and WorkLog fields are defined separately (`battle-plan/src/db.ts:46`, `battle-plan/src/db.ts:58`).
- Make UI consumers reactive to persisted state. The management surface and picker observe the project table, so create, archive, restore, and color changes appear without remounting (`battle-plan/src/components/worklogs/ProjectManager.tsx:27`, `battle-plan/src/components/worklogs/ProjectPicker.tsx:33`). Restore confirmations bind to the captured project ID, not a second name lookup.
- Validate the project in the same transaction that writes a new WorkLog. Batch voice input validates every project before adding any row, so one stale selection aborts the whole batch (`battle-plan/src/services/workLogPersistence.ts:47`).
- Preserve an unchanged historical assignment during edit. Require an active project only when the assignment changes (`battle-plan/src/services/workLogPersistence.ts:86`). Agent updates use this same boundary and preserve the WorkLog sync identity.
- Reconcile legacy collisions atomically. Prefer an active row, then the newest row, relink matching WorkLogs to that ID, and remove redundant catalog rows. The v10 Dexie upgrade repairs existing devices, and Drive sync repeats the invariant for imported data (`battle-plan/src/db.ts`, `battle-plan/src/services/workLogsSync.ts`).
- Group reports through the same canonical identity. Calendar dots and table totals must not use raw `projectName` or a name-plus-color pair as their uniqueness key (`battle-plan/src/utils/workLogProjectGrouping.ts`).

An archived normalized-name match is not silently treated as a new project. Human-facing creation asks for confirmation before restoring the original row. An explicit Agent Bridge create action already carries that intent. Legacy duplicates are data corruption, not distinct projects, so the v10 upgrade repairs them once and Drive sync repairs identities after imported changes. Normal catalog mutations can then stay proportional to the small project table.

## Manual semantic merge

Automatic normalization can safely collapse case and spacing variants, but it cannot decide that names such as “Komerční Banka” and “Komerční banka Plaza” describe the same engagement. That decision belongs to a human-confirmed source → survivor flow in `ProjectManager`.

The durable representation is deliberately small:

- `Project.aliases?: string[]` stores absorbed and previous canonical names on the survivor. These aliases are synchronized identity tombstones: they reserve the old names and prevent a stale Drive row, create, or rename from recreating a second identity.
- `mergeProjects` preserves the selected survivor's ID, name, color, active state, `createdAt`, and attribution. In one guarded Dexie transaction it advances the survivor `updatedAt`, relinks source WorkLogs by `projectId`, and removes the source. It never rewrites `WorkLog.projectName`; that field remains the historical persistence and sync snapshot, while overview cards resolve the survivor's current identity.
- `reconcileProjectIdentities` treats an unambiguous alias owner as authoritative over a stale canonical source, unions aliases deterministically, and relinks device-local IDs. Cycles or competing alias owners throw before the transaction commits; reconciliation must fail closed instead of picking the first match.
- `mergeLocalToCloud` pulls before it pushes the complete `work_logs_data.json` payload. The existing `App.tsx` live hash observes WorkLog/project counts and `updatedAt`; deleting the source and advancing the survivor therefore schedules the ordinary WorkLogs backup without a second dirty-state mechanism.
- Reports and individual overview records resolve `projectId`, canonical name, and aliases to the survivor before display. Their visible name and color come from the survivor, while each WorkLog keeps its original snapshot text internally.
- Semantic merge is human-only. Agent Bridge reuses alias-aware catalog and WorkLog validation for its existing 13 actions, but exposes no `merge_project` action and never redirects a stale project-ID mutation to the survivor.

This alias contract protects convergence only between alias-aware application builds. An older already-open PWA can still upload a payload that does not preserve metadata it does not understand, so participating devices must refresh before cross-device merge verification.

## Why This Matters

Keeping lifecycle logic in one transaction boundary prevents two callers from creating normalized duplicates and closes the gap where a project could be archived between validation and WorkLog persistence. Explicit outcomes also keep UI feedback and Agent Bridge behavior aligned. Deterministic Agent Bridge rejections are terminal acknowledgements; only transient storage or transport failures should be retried.

The denormalized project name on each WorkLog is intentional historical data. Reconciliation changes the catalog ID but preserves that snapshot for persistence, sync, audit fallback, and unchanged-assignment editing. Overview cards and reports resolve the local project ID plus snapshot identity through the canonical/alias index and use the survivor row for the displayed name and color. Numeric IDs remain device-local and are not sufficient for cross-device matching; ambiguous identity falls back to the stored snapshot instead of borrowing another project's metadata.

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
