---
title: WorkLog Canonical Project Display - Plan
type: fix
date: 2026-08-08
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# WorkLog Canonical Project Display - Plan

## Goal Capsule

- **Objective:** After a manual project merge, every WorkLog overview surface displays the survivor project's canonical name and configured color.
- **Authority:** The user's corrected presentation expectation overrides the earlier card-level historical-name rule. Stored WorkLog snapshots, alias identity, and sync behavior remain unchanged.
- **Execution profile:** Bounded presentation fix with pure resolver coverage, component wiring, documentation updates, and browser verification.
- **Stop conditions:** Stop if canonical presentation would require rewriting stored WorkLogs or weakening fail-closed alias handling.
- **Tail ownership:** LFG owns implementation, review, browser QA, commit, push, PR creation, and CI handoff.

## Product Contract

### Summary

Resolve every displayed WorkLog project through the current canonical project catalog so merged records read as one project and use its color, while retaining the original snapshot internally.

### Problem Frame

Manual merge correctly relinks records and report grouping, but WorkLog cards still render `log.projectName` and a hard-coded gray dot. The expanded table also ignores the canonical group color. This makes a completed merge look incomplete and hides the project's configured visual identity.

### Requirements

**Canonical overview presentation**

- R1. A WorkLog that resolves unambiguously to a current project displays that project's canonical name and configured color on cards, calendar detail cards, and expanded table rows.
- R2. A merged historical WorkLog resolves through the survivor ID or absorbed alias and displays the survivor identity even when its stored `projectName` is historical.
- R3. Project name or color changes update the visible overview reactively through the existing live project catalog.
- R7. Overview surfaces distinguish an unloaded project catalog from a loaded catalog with no matching identity; snapshot/slate fallback applies only after catalog loading completes.

**Safety and persistence**

- R4. The fix does not rewrite `WorkLog.projectName`, timestamps, sync identity, or any other persisted WorkLog field.
- R5. A true orphan or conflicting alias falls back to the stored snapshot and slate color. An unrelated device-local ID collision may still resolve by an unambiguous valid snapshot identity; otherwise it uses the same safe fallback.
- R6. Editing an unchanged historical assignment keeps the existing persistence and validation behavior.

### Acceptance Examples

- AE1. Given “Komerční banka Plaza” was merged into amber “Komerční Banka”, its historical card, calendar detail card, and expanded table row display “Komerční Banka” with the amber dot while the stored snapshot remains “Komerční banka Plaza”.
- AE2. Given a stale source ID and an unambiguous absorbed-name alias, the display resolves to the survivor by alias.
- AE3. Given a WorkLog ID collides with an unrelated local project and its snapshot matches no valid identity, the display keeps the snapshot with a slate dot.
- AE4. Given conflicting alias ownership, the display fails closed to the snapshot with a slate dot.

### Scope Boundaries

In scope are WorkLog overview presentation, shared canonical display resolution, tests, and durable documentation. Data migration, snapshot rewriting, sync payload changes, merge transaction changes, and Agent Bridge behavior are out of scope.

## Planning Contract

### Key Technical Decisions

- KTD1. **Resolve presentation without mutating history.** (session-settled: user-directed — chosen over displaying historical snapshot names on cards: the merged overview must read as one project.) The stored snapshot remains the persistence and sync fallback required by R4-R6.
- KTD2. **Share the alias-aware display rule.** Add a pure display resolver beside the existing WorkLog grouping index and reuse it for grouping and cards so all overview surfaces follow one identity rule.
- KTD3. **Validate ID hits before display.** A device-local ID match is accepted only when the snapshot identity is globally unambiguous and resolves to that project's canonical name or alias. An ambiguous alias falls back immediately; a mismatched ID may proceed only through a separate unambiguous name lookup.
- KTD4. **Pass one memoized index to cards.** Page and calendar owners already observe the project catalog and should pass the derived index instead of adding one Dexie query per card.

### Assumptions

- The existing project live query is the authoritative reactive source for current display metadata.
- A missing catalog identity should remain readable through its stored snapshot rather than be hidden.

## Implementation Units

### U1. Add canonical WorkLog display resolution

- **Goal:** Produce one safe `{name, color}` presentation identity for individual and grouped WorkLogs.
- **Requirements:** R2, R4, R5, R6; KTD1-KTD3; AE1-AE4
- **Dependencies:** None
- **Files:** `battle-plan/src/utils/workLogProjectGrouping.ts`, `battle-plan/src/utils/workLogProjectGrouping.test.ts`
- **Approach:** Export a pure resolver over `WorkLogProjectIndex`. Accept an ID candidate only when the snapshot identity is globally unambiguous and resolves to it. Reject ambiguous aliases immediately, otherwise fall back to unambiguous name lookup and finally to the trimmed snapshot and slate. Reuse the resolver when forming report groups.
- **Execution note:** Start with failing resolver tests for survivor display and fail-closed ID/alias cases.
- **Patterns to follow:** Existing `createWorkLogProjectIndex`, `buildProjectIdentityIndex`, and grouping tests already define canonical and ambiguous identity handling.
- **Test scenarios:**
  1. Covers AE1. Survivor ID plus absorbed snapshot returns survivor name and amber color without changing the WorkLog object.
  2. Covers AE2. Removed source ID plus absorbed alias returns the survivor identity.
  3. Covers AE3. Unrelated local ID collision with no name match returns the snapshot and slate.
  4. Covers AE4. Ambiguous alias ownership returns the snapshot and slate.
  5. An unrelated local ID collision combined with conflicting alias ownership returns the snapshot and slate.
  6. Existing canonical grouping totals, people sets, and immutable snapshot assertions remain unchanged.
- **Verification:** Focused Node tests prove resolver safety and existing grouping behavior.

### U2. Render canonical identity across overview surfaces

- **Goal:** Show canonical project names and colors on cards and table details.
- **Requirements:** R1-R3, R6-R7; KTD2, KTD4; AE1
- **Dependencies:** U1
- **Files:** `battle-plan/src/pages/WorkLogsPage.tsx`, `battle-plan/src/components/worklogs/WorkLogCard.tsx`, `battle-plan/src/components/worklogs/WorkLogCalendar.tsx`, `battle-plan/src/components/worklogs/WorkLogTable.tsx`, `battle-plan/src/utils/projectColors.ts`
- **Approach:** Wait for both WorkLogs and the live project catalog before rendering overview identities. Then memoize the project index at each owning overview, pass it into card rendering, derive the card label and dot class from the shared resolver, and use each table group's existing color. Keep edit state and unchanged-assignment validation bound to the stored WorkLog snapshot.
- **Patterns to follow:** Calendar day dots already map `ProjectColor` through `PROJECT_COLOR_DOT`; table grouping already carries canonical `name` and `color`.
- **Test scenarios:**
  1. Covers AE1. The card list and calendar day detail receive the same index and render the survivor label/color for an absorbed snapshot.
  2. A project color change in the live catalog recomputes the index and updates the card dot without a WorkLog write.
  3. Editing a displayed canonical card still preserves the unchanged historical assignment when no new project is selected.
  4. A loaded WorkLog list with a still-loading project catalog shows a lightweight loading state rather than a historical-name/slate fallback flash.
- **Verification:** TypeScript build and browser QA confirm cards, calendar detail, and expanded table use the canonical identity at desktop and narrow width.

### U3. Update durable project semantics

- **Goal:** Remove the stale rule that individual cards must expose the historical snapshot.
- **Requirements:** R1, R4; KTD1
- **Dependencies:** U1, U2
- **Files:** `CONCEPTS.md`, `docs/solutions/design-patterns/worklog-project-catalog-management.md`
- **Approach:** Distinguish immutable stored audit/sync snapshots from current canonical overview presentation. Preserve the documented alias tombstone and fail-closed rules.
- **Patterns to follow:** Keep `CONCEPTS.md` concise and update the existing catalog learning in place.
- **Test scenarios:** Test expectation: none -- documentation mirrors behavior verified by U1 and U2.
- **Verification:** Documentation review finds no current statement requiring historical snapshot text on individual overview cards.

## Verification Contract

| Gate | Units | Done signal |
|---|---|---|
| Focused WorkLog grouping tests | U1 | Canonical, alias, collision, ambiguity, and immutability scenarios pass. |
| Full `npm test` in `battle-plan` | U1-U2 | All WorkLog/project regressions pass. |
| `npm run lint` and `npm run build` in `battle-plan` | U1-U2 | ESLint and TypeScript/Vite complete without errors. |
| Browser QA | U2 | A merged historical card, calendar detail, and expanded table row show the survivor name and configured color. |
| Documentation review | U3 | Current glossary and solution guidance distinguish stored snapshot from canonical presentation. |

## Definition of Done

- Merged WorkLogs display one canonical project name and color across overview surfaces.
- True orphan and conflicting identities fall back safely without borrowing another project's metadata.
- No persisted WorkLog or sync identity is rewritten by display resolution.
- Focused and full automated checks pass, and browser QA reproduces the reported scenario successfully.
- Durable project documentation reflects the new presentation contract.
- No abandoned experimental code or unrelated user files are included in the diff.
