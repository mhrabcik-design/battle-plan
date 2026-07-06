---
title: Inject App Context into AI Prompts
type: feat
status: active
date: 2026-07-06
origin: agent-native audit recommendation 4 from the 2026-07-06 audit (49% overall)
---

# Inject App Context into AI Prompts

## Summary

Adds a small async helper that builds a structured "app state snapshot" once per AI call and injects it into the `semanticEngine` system prompt for the voice / agent path. The snapshot includes the active project roster, today's worklog titles + counts, the next seven days of pending suggestions, the configured Gemini model + UI scale, and the current locale. Closes audit recommendation 4.

## Problem Frame

The voice path (`app:useGlobalVoiceProcessing` → `semanticEngine.applySemanticResult` → Gemini) and the WorkLog extraction path (`workLogExtractor.processWorkLogAudio` → `buildWorkLogSystemPrompt`) both call Gemini with a system prompt that mentions "Dnešní datum" and, in the update case, the previous task's title / description. They mention nothing about the user's current state — no active projects, today's worklog volume, the model in use, or the UI scale. The AI cannot say "you already created a project called Plaza today" or "you logged 6h on Plaza today" because it has no signal.

The cost is small: one Dexie read per call (with a single batching helper that issues `db.projects.toArray`, `db.workLogs.toArray`, `db.settings.get`, `db.suggestions.toArray` and then composes the snapshot). The 4.3.26 agent path already passes `existing` to `normalizeEntity`; this plan adds a separate `appContext` parameter that flows alongside it.

## Requirements

- R1. A new exported `buildAppContext()` function returns `Promise<AppContext>` with fields: `activeProjects: { id, name, color }[]`, `todaysWorklogs: { id, projectName, hours }[]`, `recentSuggestions: { id, title, category, status }[]` (up to 5 open), `config: { model: string; uiScale: number; locale: string }`.
- R2. The `getSystemPrompt` signature in `semanticEngine` accepts an `appContext: AppContext` parameter (in addition to the existing four) and renders a "## 🗂️ Aktuální stav appky" section above the existing manifest.
- R3. The voice / agent path (`geminiService.processAudio`) calls `buildAppContext()` once at the start of each call and passes the result to `getSystemPrompt`. The cost is one Dexie roundtrip; the result is small (< 4 KB rendered into the prompt).
- R4. The WorkLog prompt (`workLogExtractor.buildWorkLogSystemPrompt`) accepts the same `AppContext` and renders a short form (active project ids only; today's existing worklog counts).
- R5. The new context section is bounded: the list of active projects is truncated at 20 names, today's worklogs at 10 titles, open suggestions at 5. Beyond the limits the snapshot only reports a count suffix (e.g. `+12 dalších`).
- R6. The build never throws on an empty db — an empty app state renders as a one-liner ("žádný projekt") and does not break the AI call.

## Scope Boundaries

- In scope: `geminiService`, `semanticEngine`, `workLogExtractor`, a new `appContext.ts` helper.
- Out of scope: changing what the AI does with the context (the prompt already says "use existing projects / worklogs as the default"); surfacing the context in the UI; persisting per-user context to Drive (the snapshot is rebuilt per call); caching the snapshot between calls (per-call rebuild is cheap enough; caching adds stale-data risk).

### Deferred to Follow-Up Work

- Computing the snapshot at the application boot and refreshing on writes (perf optimization). The current per-call rebuild takes < 5ms on the seeded db; the cache is not yet justified.
- Surfacing the snapshot to the user (a sidebar panel showing what the AI sees). Audit recommendation 5 covers capability discovery / onboarding; this is a related but separate concern.

## Context & Research

### Relevant Code and Patterns

- `battle-plan/src/services/geminiService.ts:148-162` — the call site that builds `contextInfo` for the update path; the snapshot helper here replaces the inline build.
- `battle-plan/src/services/workLogExtractor.ts:312-321` — the WorkLog system prompt is currently `WORKLOG_SYSTEM_PROMPT` (string const) with `referenceDate` only; the snapshot injects a small "## Kontext" section.
- `battle-plan/src/services/semanticEngine.ts:6` — `getSystemPrompt` signature; this plan extends it with `appContext`.
- `battle-plan/src/db.ts:80-124` — Dexie schema v9; `db.projects`, `db.workLogs`, `db.settings`, `db.agentInbox` are the live tables to read.
- `battle-plan/src/hooks/useGlobalVoiceProcessing.ts:34-93` — the voice pipeline that calls `geminiService.processAudio`; the snapshot is built inside the service so the hook is not changed here.

### Institutional Learnings

- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` — the AI assistant already tolerates missing scopes; the snapshot does not require any specific Google auth or scope to build.
- `docs/solutions/logic-errors/offline-auth-state-unreachable-2026-07-04.md` — Dexie reads are independent of the auth state machine; the snapshot builds regardless of auth.

### External References

None.

## Key Technical Decisions

- The snapshot reads `db.projects`, `db.workLogs`, `db.settings`, and `db.suggestions` in **four sequential reads** rather than one transaction. Reason: Dexie's indexed reads are fast enough that a transaction wrapper adds complexity without changing latency in any observable way. If a future plan measures bottleneck, swapping to `db.transaction('r', [projects, workLogs, settings, suggestions], ...)` is a localized change.
- The active projects filter reuses the same pattern as `useDriveSyncOrchestration.mergeCloudToLocal` (`isActive: true`). The reviewer's project list reflects the picker.
- Today's worklog filter compares `date` ISO string equal to today's ISO string in the user's local timezone. The same `toIsoDate` helper from `utils/workLogBatch.ts` is reused.
- The truncation rule (R5) is applied per-section, not globally. The truncated list is rendered, then a `(+N dalších)` suffix is appended.
- The model name is read from `db.settings.get('gemini_model')`. Locale is hardcoded to `'cs-CZ'` for now (matches the app's body); a future i18n plan will thread a real locale through.

## Open Questions

### Resolved During Planning

- **Where does the snapshot live?** New `appContext.ts` file under `src/services/`. This keeps the snapshot compose / dispatch in one place.
- **Where is `buildAppContext` invoked?** Inside `geminiService.processAudio` for the voice / agent path; inside `workLogExtractor.processWorkLogAudio` for the worklog path. That keeps the snapshot lazy (only built when the AI is called).

### Deferred to Implementation

- Whether the snapshot should include a per-day count of completed tasks (vs. the existing today's worklogs). This is a UX-level decision about what signal is most useful.
- Whether `recentSuggestions` should include `accepted` / `converted` entries (audit trail). R3 says open only; defer expansion.

## Implementation Units

### U1. Add `appContext.ts` helper

**Goal:** One exported `buildAppContext()` function that returns the snapshot.

**Requirements:** R1, R5, R6.

**Dependencies:** None.

**Files:**
- Create: `battle-plan/src/services/appContext.ts`

**Approach:**
- Export interface `AppContext` with the four fields listed in R1.
- Export `async function buildAppContext(): Promise<AppContext>` that reads the four tables, applies the per-section truncations, and returns the snapshot.

**Test scenarios:**
- Happy path: a fixture with two projects, three worklogs, two open suggestions, and one setting returns the snapshot with the expected shape.
- Truncation: a fixture with 25 active projects returns the first 20 plus a `+5 dalších` suffix in the `activeProjects` slice.
- Empty db: an empty fixture returns a snapshot with all-empty arrays and a `model: 'gemini-3-flash-preview'` default.

**Verification:** Add a `appContext.test.ts` next to the existing service test files; follow the `node:test` + `fake-indexeddb/auto` pattern from `agentBridge.test.ts`.

### U2. Extend `getSystemPrompt` in `semanticEngine`

**Goal:** Add an `appContext` parameter and render the new section.

**Requirements:** R2.

**Dependencies:** U1.

**Files:**
- Modify: `battle-plan/src/services/semanticEngine.ts`

**Approach:**
- Import the new `AppContext` type from `appContext.ts`.
- Extend the `getSystemPrompt` signature to `getSystemPrompt(dayName, today, now, contextInfo, appContext)`.
- Render the new section after the "## 📅 LOGIKA TERMÍNŮ" section, before the profile blocks. The render uses the truncation rules (activeProjects up to 20, todaysWorklogs up to 10, recentSuggestions up to 5).
- Keep the function signature backward-compatible in the agent path: `normalizeEntity` does not pass `appContext` (it's a Task-only helper), so the change to the existing 4-arg call site is `geminiService.processAudio` only.

**Patterns to follow:** the existing `contextInfo` interpolation at line 10.

**Test scenarios:**
- Happy path: a snapshot with two projects renders them in the right markdown list, and the section header is present.
- Empty snapshot: the section says "žádné aktivní projekty" and does not break the resulting string.

**Verification:** A unit test renders the prompt and asserts the substring "Aktivní stav appky" appears.

### U3. Wire `buildAppContext` in `geminiService.processAudio`

**Goal:** Build the snapshot once per call and pass it to `getSystemPrompt`.

**Requirements:** R3.

**Dependencies:** U1, U2.

**Files:**
- Modify: `battle-plan/src/services/geminiService.ts`

**Approach:**
- Import `buildAppContext` from `./appContext.ts`.
- Call `await buildAppContext()` once after the `existingTask` read (so the existing `contextInfo` string is built first) and pass it through to `getSystemPrompt`.
- Adjust the `processAudio` signature's callsite accordingly — no breaking change to external callers.

**Patterns to follow:** the existing `await db.tasks.get(contextId)` snapshot pattern.

**Test scenarios:**
- Happy path: `processAudio` calls `buildAppContext` once and passes the result to `getSystemPrompt`.
- Error path: `buildAppContext` throwing does not break the AI call (the existing try/catch logs and falls through to the existing error path).

**Verification:** A unit test mocks `db.projects.toArray` / `db.workLogs.toArray` and asserts the resulting `getSystemPrompt` contains the snapshot section.

### U4. Wire `buildAppContext` in `workLogExtractor.processWorkLogAudio`

**Goal:** Build the WorkLog-truncated snapshot and pass it to `buildWorkLogSystemPrompt`.

**Requirements:** R4.

**Dependencies:** U1, U2.

**Files:**
- Modify: `battle-plan/src/services/workLogExtractor.ts`

**Approach:**
- Import `buildAppContext` from `./appContext.ts`.
- Extend the `WORKLOG_SYSTEM_PROMPT` template with a short "Kontext" section; only `activeProjects` (up to 20 names + colors) and "today's worklog count" are rendered. The rest of the WorkLog prompt stays focused on time / people / project extraction.
- Call `await buildAppContext()` once per `processWorkLogAudio` and pass the result through to `buildWorkLogSystemPrompt`.

**Patterns to follow:** the existing `referenceDate = new Date()` flow.

**Test scenarios:**
- Happy path: the WorkLog prompt contains the active projects section.
- Empty db: the section renders a one-liner "žádné aktivní projekty".

**Verification:** A unit test reads the resulting prompt and asserts "Kontext" appears.

## System-Wide Impact

- **Interaction graph:** Two service entry points (`geminiService.processAudio`, `workLogExtractor.processWorkLogAudio`) each add one Dexie roundtrip. The Prompt content changes for both paths.
- **Error propagation:** `buildAppContext` reads four Dexie tables; a Dexie failure is caught by the existing per-call `try { ... } catch`. The AI call falls through to its existing failure path; no new error surface.
- **State lifecycle risks:** None — the snapshot is built from Dexie at call-time and is not persisted or cached.
- **API surface parity:** None — the snapshot is internal to the AI path. The agent write contract (4.3.26) is untouched.
- **Integration coverage:** Manual smoke in next release: speak a Voice command — the AI now references today's worklog count or active project names when relevant.
- **Unchanged invariants:** The four-state Google auth model, the `db.agentInbox` mirror, the polling cadence (subject of the `rec 10` plan), and the agent write contract are untouched. The `applySemanticResult` voice path produces identical Task outputs because the prompt only adds context, never changes the manifest.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `buildAppContext` reads many tables on every AI call; latency grows. | The four Dexie reads are fast (sub-ms each on seeded data). If the snapshot ever becomes a bottleneck, a per-mount cache invalidated by `db.use` listeners is the natural follow-up. |
| The snapshot grows the prompt by 4 KB, pushing some Gemini requests over the per-call token cap. | The truncation rules (R5) cap the rendered size to well under 1 KB. The WorkLog prompt adds ~200 B. |
| A stale snapshot after a sync round that introduces / renames / deletes a project. | The snapshot is rebuilt per call; the next AI call after a sync sees the new state. |

## Documentation / Operational Notes

- The version bump follows the auto-bump workflow.
- The AI will start to reference the active project roster in its responses; users will notice this in the next release.
- No new env vars, no new dependencies.

## Sources & References

- Audit origin: agent-native audit on 2026-07-06, recommendation 4 (deferred in the original plan scope boundaries)
- Plan source: `docs/plans/2026-07-06-001-feat-widen-agent-write-contract-plan.md` § Scope Boundaries (rec 4 deferred)
- Related code:
  - `battle-plan/src/services/semanticEngine.ts:1-220`
  - `battle-plan/src/services/geminiService.ts:148-162`
  - `battle-plan/src/services/workLogExtractor.ts:312-321`
- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` (per-feature scope discipline)
