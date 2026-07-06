---
title: Add Project and Suggestion Delete UI
type: feat
status: active
date: 2026-07-06
origin: agent-native audit recommendation 9 UI from the 2026-07-06 audit (49% overall)
---

# Add Project and Suggestion Delete UI

## Summary

Closes the user-facing half of audit recommendation 9. Adds a Delete button to each project row in `ProjectPicker` and to each suggestion card in `SuggestionsPage`. Wired to the existing `db.projects` soft-delete path (already in place since the 4.3.26 wire-up of the agent contract) and a new `suggestionsSync.deleteSuggestion` for hard delete. Keeps existing accept / reject / defer / reply behaviors intact.

## Problem Frame

The 4.3.26 agent write contract lets Anu create and archive projects (`create_project`, `delete_project`) and reject suggestions via `updateSuggestionStatus(suggestion.id, 'rejected')`. From the user's perspective this means projects and suggestions accumulate forever on the local side — there is no way to delete a project from the UI, and a rejected suggestion just gets a status label "Zamítnutý" that still occupies the suggestion list. There is no `db.projects.delete` user-flow and no `db.suggestions.delete` is exposed; the agent plan deferred the user-side UI to this plan.

Both deletions are small surface additions: `ProjectPicker` already lists active projects and renders a row per project; `SuggestionCard` already has a row-level action bar (Accept / Reject / Defer / Reply). Adding a Delete button next to those is a localized change that needs no new dependency or schema migration.

## Requirements

- R1. Each project row in `ProjectPicker`'s dropdown exposes a Delete affordance that performs the existing soft-delete path (`db.projects.update(id, { isActive: false, updatedAt: now })`) without removing the row.
- R2. `ProjectPicker` no longer lists deleted projects after the delete completes (its `isActive` filter at `ProjectPicker.tsx:31` keeps the dropdown accurate after `loadProjects()`).
- R3. If the user has the deleted project currently selected, the picker deselects it locally so the trigger label falls back to "— Vyberte projekt —".
- R4. Each suggestion card (`SuggestionCard`) exposes a Delete affordance next to Accept / Reject / Defer.
- R5. `suggestionsSync.deleteSuggestion(suggestionId)` performs a hard delete from the Drive JSON file (`agent-suggestions.json`) and returns `{ success: boolean }` to mirror the existing `updateSuggestionStatus` contract.
- R6. After a successful delete, `SuggestionsPage` removes the card from the local state and the diagnostics "Pending agent writes" surface (when one exists) does not show this id again. There is no Dexie mirror for suggestions today, so the local-state removal is the only cleanup needed.
- R7. Delete is irreversible on the local UI (no undo). The Drive file is the durable record; if the suggestion survives a Drive re-read it would reappear. To prevent that, `deleteSuggestion` strips the id from the suggestion array in `agent-suggestions.json`.
- R8. Confirmation prompt before each delete (single button click followed by `window.confirm`) — same UX pattern the app already uses for other destructive actions.
- R9. The Delete affordance is hidden when the suggestion is already `accepted` or `converted`, so the user cannot delete a suggestion they have already acted on (those are part of the audit trail and should be hidden / filtered instead).

## Scope Boundaries

- In scope: `ProjectPicker` (delete button + handler), `SuggestionCard` (delete button + handler), `SuggestionsPage` (wire up `onDelete`), `suggestionsSync.ts` (new `deleteSuggestion` method), `Settings` UI does not need a delete path (settings are already in scope of the 4.3.26 agent contract via `delete_settings` for `gemini_api_key`).

- Out of scope: an Undo / restore path; bulk delete; multi-select.

### Deferred to Follow-Up Work

- A dedicated `agent-suggestions-trash.json` file mirroring `db.agentInbox` for soft deletes (so accidental deletes can be undone). Not necessary at this surface; the plan ships the lighter-weight hard delete.
- A `db.deletedSuggestions` mirror in Dexie. The bridge already has the mirror machinery; adding another table for this is straightforward but offers no value over a hard delete today.
- Filtering deleted Worklogs whose `projectId` references a soft-deleted project. The `WorkLogExtractor` and `ProjectPicker` already route around `isActive = false`; no WorkLog cleanup is needed for this scope.

## Context & Research

### Relevant Code and Patterns

- `battle-plan/src/components/worklogs/ProjectPicker.tsx:1-220` — the project picker being extended. Its row rendering (lines ~119-152, the project list) is where the delete button goes.
- `battle-plan/src/components/SuggestionCard.tsx:1-434` — the suggestion card being extended. The action row (lines around 290-330 in the original, currently `X` reject icon) is where the delete button goes.
- `battle-plan/src/services/suggestionsSync.ts:1-250` — already has `updateSuggestionStatus` (lines 146-167); adds a parallel `deleteSuggestion` method.
- `battle-plan/src/pages/SuggestionsPage.tsx:1-500` — wires the suggestion card. Lines ~115-160 already do the existing `onAccept` / `onReject` / `onDefer` handlers; the new `onDelete` follows the same shape (async, optimistic local state remove, log on failure).

### Institutional Learnings

- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` — `applyWrite` and the agent path swallow per-call errors rather than throwing. The same discipline applies to `deleteSuggestion` (return `{ success: false }`, do not throw).
- `docs/solutions/integration-issues/drive-readiness-diagnostic-states-2026-07-05.md` — three-state diagnostic mapping. A delete-of-unknown-id (stale local state) reads as `ready`; no diagnostic state change needed here.
- `docs/solutions/integration-issues/ensure-fresh-token-refresh-dedup-2026-07-04.md` — the existing `runRefresh` discipline survives any UI change because the UI does not touch the auth surface.

### External References

None.

## Key Technical Decisions

- `deleteSuggestion` writes the updated `agent-suggestions.json` JSON directly via `DriveJsonStore.writeJsonFile`, mirroring the pattern in `updateSuggestionStatus` (lines 154-162). Adding a dedicated method to the service is cleaner than inlining the Drive call in `SuggestionsPage`.
- The `agent-suggestions.json` filter is structural (drops the id from the `suggestions` array). A soft status of `deleted` is not added because the audit rec says "delete path" and the Surface pattern in this app is irreversible from the user's perspective — we keep it simple.
- `ProjectPicker`'s delete is local-only (no Drive write). Reasoning: `db.projects` is the source of truth for project visibility (per the merge from `taskDriveBackup` and `workLogsSync`), and the soft-delete is propagated by `mergeCloudToLocal` on the next Drive sync. A Drive write here would race the next 30s sync. Local-only delete preserves project visibility deactivation while the Drive catch-up happens.
- Confirmation uses `window.confirm(...)` — same UX pattern as the existing settings export and the WorkLog delete (if any). Project Picker's existing UI is small (one button row), so an inline confirm is enough; a modal is not necessary.

## Open Questions

### Resolved During Planning

- **Should projects delete propagate to Drive?** Local-only is fine because `mergeCloudToLocal` will eventually pick up the soft delete and other devices will see `isActive = false`. A direct Drive write on the project file would be incorrect — projects are stored as part of `taskDriveBackup.battle_plan_data.json` (worklog extractor's `battle_plan_data`), not as their own file.
- **Should suggestion delete be reversible?** No — the user explicitly opts in to "remove this card" and the existing accept / reject paths are also terminal.

### Deferred to Implementation

- Whether `deleteSuggestion` should also strip the suggestion's replies from `agent-suggestion-replies.json`. Pragma: yes, because orphans would otherwise re-attach to the next live suggestion with a recycled id. Implementing this in `deleteSuggestion` keeps the deletion self-contained.

## Implementation Units

### U1. Add `deleteSuggestion` to `suggestionsSync`

**Goal:** New service method that removes a suggestion by id from `agent-suggestions.json`.

**Requirements:** R5, R7.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/services/suggestionsSync.ts`

**Approach:**
- Add `async deleteSuggestion(suggestionId: string): Promise<{ success: boolean }>` on the `SuggestionsSync` class.
- Reuse the existing `readJsonFile` / `writeJsonFile` calls; filter the `suggestions` array to remove the entry by id; persist; return `{ success: true }`.
- If the suggestion isn't found (re-read after a stale local state), still return `{ success: true }` — the desired end state is achieved regardless.
- Wrap in `try { ... } catch` matching the existing `updateSuggestionStatus` shape; return `{ success: false }` on failure and log.

**Patterns to follow:** `updateSuggestionStatus` (`battle-plan/src/services/suggestionsSync.ts:146-167`).

**Test scenarios:**
- Happy path: `deleteSuggestion('id-1')` removes 'id-1' from the suggestion list and persists.
- Edge case: deleting a non-existent id is a no-op success.
- Error path: simulating a Drive write failure returns `{ success: false }`.

**Verification:** A unit test in `suggestionsSync.test.ts` (or whichever the test surface lives on after the current conventions) verifies the three scenarios.

### U2. Add Delete button + confirm to `ProjectPicker`

**Goal:** Each project row in the picker dropdown exposes a trash button; clicking it asks for confirmation and applies the existing soft-delete.

**Requirements:** R1, R2, R3, R8.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/components/worklogs/ProjectPicker.tsx`

**Approach:**
- Add a `Trash2` (or similar) icon button in each project row, on the right of the row, parallel to the existing select button.
- Implement `handleDelete = async (project: Project) => { if (!window.confirm(`Smazat projekt „${project.name}"?`)) return; await db.projects.update(project.id!, { isActive: false, updatedAt: Date.now() }); if (selectedProjectId === project.id) onSelect(...); ... await loadProjects(); }`.
- After delete, `loadProjects()` rerenders the dropdown without the deleted entry; if the deleted project was the current selection, the picker falls back to "— Vyberte projekt —" by detaching `selectedProjectId`.

**Patterns to follow:** the existing `handleCreate` shape (`ProjectPicker.tsx:56-90`).

**Test scenarios:**
- Happy path: clicking Delete on a non-selected project removes it from the dropdown without unselecting anything.
- Happy path: clicking Delete on the currently selected project removes it from the dropdown and clears the trigger to the placeholder label.
- Edge case: `window.confirm` returning `false` leaves the picker unchanged.

**Verification:** A render test (RTL or jsdom) verifies the dropdown updates after a confirmed delete. If a full RTL setup is out of scope for this iteration, the manual smoke check is "delete a project from the picker and confirm it disappears."

### U3. Add Delete button + confirm to `SuggestionCard`

**Goal:** Each card exposes a Delete option in the action row that confirms and removes the card.

**Requirements:** R4, R8, R9.

**Dependencies:** U1 (the deleteSuggestion service method).

**Files:**
- Modify: `battle-plan/src/components/SuggestionCard.tsx`

**Approach:**
- Add an `onDelete: () => Promise<void>` prop.
- Render a Trash button next to the existing Reject (`X`) icon.
- Wrap the button click in `window.confirm` to satisfy R8.
- The button is hidden for `status === 'accepted'` or `status === 'converted'`.

**Patterns to follow:** the existing `onReject` shape.

**Test scenarios:**
- Happy path: clicking Delete invokes `onDelete` after a confirm.
- Happy path: clicking Delete with `window.confirm` returning `false` does not invoke `onDelete`.
- Visibility gate: an `accepted` or `converted` card does not render the Delete button.

**Verification:** A render test verifies the visibility gate and that the click invokes `onDelete` on confirm.

### U4. Wire `onDelete` in `SuggestionsPage`

**Goal:** `SuggestionsPage` provides an `onDelete` to each `SuggestionCard` that calls `suggestionsSync.deleteSuggestion` and removes the row from local state.

**Requirements:** R6.

**Dependencies:** U1, U3.

**Files:**
- Modify: `battle-plan/src/pages/SuggestionsPage.tsx`

**Approach:**
- Add `handleDelete = async (suggestionId: string) => { await suggestionsSync.deleteSuggestion(suggestionId); setSuggestions((prev) => prev.filter((s) => s.id !== suggestionId)); setRepliesBySuggestion((prev) => { const next = { ...prev }; delete next[suggestionId]; return next; }); addLog(...); }`.
- Pass `onDelete={handleDelete}` to `SuggestionCard` at line ~412.
- Mirror the local optimistic update pattern of the existing `onReject` handler (lines ~163-170).

**Patterns to follow:** the optimistic update shape used by `handleReject` / `handleDefer`.

**Test scenarios:**
- Happy path: invoking `handleDelete` removes the suggestion from `suggestions` state and from `repliesBySuggestion`, and `suggestionsSync.deleteSuggestion` is called.
- Error path: if `deleteSuggestion` returns `{ success: false }`, the suggestion is not removed from local state and `addLog('Smazat návrh selhal', 'error')` is shown.

**Verification:** A render test mocks `suggestionsSync.deleteSuggestion` and verifies the optimistic update path.

## System-Wide Impact

- **Interaction graph:** `ProjectPicker` only mutates `db.projects`; `SuggestionsPage` calls `suggestionsSync.deleteSuggestion` which uses `DriveJsonStore`. The Delete UI surface is additive to the existing interaction surface; nothing else fires on a project or suggestion deletion.
- **Error propagation:** Both U1 and U4 catch and return `{ success: false }`; the UI handles the failure by leaving the row in place and logging. No throw escapes the surface.
- **State lifecycle risks:** Optimistic local-state removal in U4 must roll back if the Drive write fails. The implementation uses a "fire and forget" optimistic pattern; a defensive `try { setSuggestions(...) }` ensures the local state moves even on failure — a follow-up plan can add a rollback if the UX feedback is confusing.
- **API surface parity:** None beyond adding `deleteSuggestion` to `suggestionsSync`; the existing agent path stays compatible.
- **Integration coverage:** Manual smoke in next release: create a project via Picker, delete it, confirm it disappears immediately and after a Drive sync cycle.
- **Unchanged invariants:** The four-state Google auth model, the `db.agentInbox` mirror, the agent write contract, the 4.3.26 cross-entity `source/agent_write_id` attribution, the `mirrorInbox` polling discipline — all untouched. Delete UI is a user-side complement to the agent write contract, not a contract change.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `window.confirm` returns `false` after a slow delete — user taps Delete, nothing happens, they retry. | The confirm prompt is the explicit friction; the behavior is intentional and matches the existing WorkLog delete UX. |
| `suggestionsSync.deleteSuggestion` writes `agent-suggestions.json` while another sync round is reading the same file. | The bridge already coalesces reads and writes; the file write is atomic on the Drive side. Worst case is one polling-tick delay before the deletion surfaces on other devices. |
| The Delete button on a card survives the suggestion status transition (e.g. accepted -> open from another client). | R9 pins Delete visibility to `status === 'accepted' || 'converted'`; other clients re-render with the same gate. |

## Documentation / Operational Notes

- The version bump follows the auto-bump workflow.
- The Delete affordance is a small visible UI change. Users discover it via the row action; no onboarding step is required.
- No new env vars, no new dependencies.

## Sources & References

- Audit origin: agent-native audit on 2026-07-06, recommendation 9 UI half (deferred in the original plan scope boundaries)
- Plan source: `docs/plans/2026-07-06-001-feat-widen-agent-write-contract-plan.md` § Scope Boundaries (rec 9 UI deferred)
- Related code:
  - `battle-plan/src/components/worklogs/ProjectPicker.tsx:1-220`
  - `battle-plan/src/components/SuggestionCard.tsx:1-434`
  - `battle-plan/src/pages/SuggestionsPage.tsx:1-500`
  - `battle-plan/src/services/suggestionsSync.ts:146-167` (precedent for `deleteSuggestion`)
