---
title: Prompt-Nativize Task Normalization
type: refactor
status: active
date: 2026-07-06
origin: agent-native audit recommendation 7 from the 2026-07-06 audit (49% overall)
---

# Prompt-Nativize Task Normalization

## Summary

Moves the type taxonomy, urgency clamp, isAllDay logic, and startTime defaults from `semanticEngine` TypeScript helpers into the Gemini system prompt itself. The TypeScript layer keeps only the **safety-net** sanitization: the same code paths stay, but they become narrower and most of the rules live in the prompt where the AI reads them. Closes audit recommendation 7.

## Problem Frame

The system prompt (`getSystemPrompt` in `semanticEngine.ts`) and the TypeScript helpers (`normalizeType`, `clampUrgency`, `clampIsAllDay`, `clampProgress`, the `startTime` default by type) duplicate the same rules in two places. The prompt says "USE ONLY: 'task', 'meeting', 'thought'" and "URGENCE: 3=Urgentní, 2=Normální (default), 1=Nízká"; the TypeScript helpers enforce the same with `EXACT_TYPE_MAP`, `Math.min(3, Math.max(1, n))`, and `finalType === 'meeting' ? '09:00' : ...` patterns. The duplication is the canonical "code-define-vs-prompt-define" risk: a rule change has to be made in two places; the two can drift; one of them is usually wrong.

The audit rec frames this as "the AI can decide this better than the code." That is true for rules the AI can read (type synonym table, urgency default 2, startTime = 15:00 for tasks). It is not true for rules that the AI can mis-output (a 0 in a 1..3 urgency scale, an unparseable bool). The plan therefore does a **federated** split: prompt owns the high-level rules, code owns the parse safety net.

## Requirements

- R1. The system prompt adds a "## ⚙️ SANITIZAČNÍ PRAVIDLA (tato pravidla dodržuj dříve než vrátíš výstup)" section with:
  - **Type**: `task`, `meeting`, `thought` only. Czech synonyms map to the same type (`úkol` → `task`, `sraz`/`schůzka` → `meeting`, `myšlenka`/`poznámka`/`note` → `thought`). Anything else → `thought`.
  - **Urgency**: scale 1..3 with default 2. Sentence-form mapping: 1 = Nízká, 2 = Normální, 3 = Urgentní. If ambiguous, default 2.
  - **isAllDay**: true if user said "na celý den / celodenní / bez času / celý den". Clear `startTime` and set type-default `duration`.
  - **startTime default**: meeting → `09:00`, task → `15:00`. Honored if the user did not specify a time.
  - **progress**: integer 0..100.
- R2. The TypeScript helpers (`EXACT_TYPE_MAP`, `normalizeType`, `clampUrgency`, `clampIsAllDay`, `clampProgress`, the startTime-default inline branches) move to a new `taskNormalization.ts` file and become narrower: they are typed as `assertValidTask` taking a partial `Task` and returning a fully-typed `Task`. They stay defensive (`clampUrgency(undefined) → 2`), but the rules they enforce are now described in the prompt.
- R3. `normalizeEntity` keeps its `Task`-shaped return type and its `clampUrgency` / `clampIsAllDay` calls — but the rationale block is shorter and references "the prompt's SANITIZAČNÍ PRAVIDLA" for the high-level rules.
- R4. The prompt is updated by `getSystemPrompt`; the `appContext` snapshot from `rec 4` continues to work.

## Scope Boundaries

- In scope: `semanticEngine` system prompt, the inline `normalizeType` / `clampUrgency` / `clampIsAllDay` / `clampProgress` / startTime-default branches, and a new `taskNormalization.ts` module.
- Out of scope: a fully type-driven prompt generator (the prompt remains a string literal); prompt-only rules (the code keeps the safety net); AI model selection (the rules are model-agnostic); the WorkLog extractor (its `WORKLOG_SYSTEM_PROMPT` already lives as a separate prompt string and is not affected here).

### Deferred to Follow-Up Work

- A pre-flight prompt-only test fixture that asserts the system prompt contains the sanitization rules. Manual review is sufficient for this iteration.
- A separate "rules file" consumed by both `getSystemPrompt` and the WorkLog prompt. Single source of truth across two prompt modules is a larger refactor; for this plan the rules live in the Task prompt only.
- A per-field constraint table in TS that the prompt mirrors (e.g. `URGENCY_RANGE = [1, 2, 3] as const`). The prompt approach is the audit rec's preferred outcome; the type table is a follow-up.

## Context & Research

### Relevant Code and Patterns

- `battle-plan/src/services/semanticEngine.ts:1-220` — the prompt and the helpers.
- `battle-plan/src/services/workLogExtractor.ts:312-321` — the WorkLog prompt (the precedent for "string const + template"; the Task prompt follows the same shape).
- `battle-plan/src/services/semanticEngine.ts:1-70` — the existing rule blocks inside the prompt; this plan adds a "## ⚙️ SANITIZAČNÍ PRAVIDLA" section in the same style.

### Institutional Learnings

- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` — the Tasks-scope 403 swallow pattern. The narrowing in this plan does not change that surface; the prompt-rules changes are isolated to the Task manifest.
- `docs/solutions/best-practices/helper-extraction-test-rewriting-2026-07-04.md` — when extracting a helper, the test contract is rewritten first. This plan does extract `taskNormalization.ts` and follows that pattern.

### External References

None.

## Key Technical Decisions

- The sanitization rules move **out of `clampUrgency` / `clampIsAllDay`** in a structural way: the prompt explicitly tells the AI what to output, and the TypeScript helper only "rounds" a value that the AI may have mis-typed. The helper never overrides a value the AI set correctly.
- The Czech synonym table (`úkol` → `task`, `sraz` → `meeting`, etc.) lives in the prompt as a one-liner. The TypeScript helper still has the same `EXACT_TYPE_MAP` so the safety net applies to a non-Czech-speaking user (e.g. if the user pastes a transcription with "task" or "meeting" in English).
- The `startTime` default by type is described in the prompt as a sentence ("If user did not specify a time, use 09:00 for meetings, 15:00 for tasks"). The TypeScript helper still defaults to those values when the AI output is empty.
- The `progress` clamp moves to a "0..100 integer" rule in the prompt; the TypeScript helper still does `Math.min(100, Math.max(0, Math.round(n)))` for safety.

## Open Questions

### Resolved During Planning

- **Do we delete the TypeScript helpers?** No. The safety net stays; the prompt does the heavy lifting. A future plan can fully remove the helpers if the prompt-only path proves reliable.
- **Where does the new section live in the prompt?** After the "## 📅 LOGIKA TERMÍNŮ" block, before the profile blocks. The order keeps the manifest → terminology → sanitization → profile progression.

### Deferred to Implementation

- Whether the prompt should include examples of mis-typed values (e.g. "Do NOT return 'TASK' or 'Meeting' — only 'task' / 'meeting' / 'thought'"). Defer until the first Gemini regression.

## Implementation Units

### U1. Add the sanitization section to `getSystemPrompt`

**Goal:** Add the "## ⚙️ SANITIZAČNÍ PRAVIDLA" section to the prompt.

**Requirements:** R1.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/services/semanticEngine.ts`

**Approach:**
- Insert the new section after the "## 📅 LOGIKA TERMÍNŮ" block.
- Render the rules as a numbered list.
- Append the section to the prompt template literal; no other change to the prompt body.

**Patterns to follow:** the existing markdown section style.

**Test scenarios:**
- Happy path: `getSystemPrompt(...)` returns a string that contains the substring "SANITIZAČNÍ PRAVIDLA".
- Happy path: the section enumerates Type, Urgency, isAllDay, startTime default, and progress.

**Verification:** A unit test asserts the substring is present.

### U2. Extract `taskNormalization.ts` and narrow the helpers

**Goal:** Move `normalizeType`, `clampUrgency`, `clampIsAllDay`, `clampProgress` into a new module; keep the safety-net role; remove the now-redundant inline branches from `normalizeEntity`.

**Requirements:** R2, R3.

**Dependencies:** U1 (the prompt section justifies the narrowing).

**Files:**
- Create: `battle-plan/src/services/taskNormalization.ts`
- Modify: `battle-plan/src/services/semanticEngine.ts`

**Approach:**
- Create `taskNormalization.ts` with the four helpers exported as `clampUrgency`, `clampIsAllDay`, `clampProgress`, `normalizeType`, plus a small `inferStartTimeByType(type: Task['type'])` that returns `'09:00' | '15:00' | undefined`.
- In `semanticEngine.ts`, delete the inline helpers; import the new module.
- Add a single-line doc comment to each import site referencing "the prompt's SANITIZAČNÍ PRAVIDLA" as the source of truth.

**Test scenarios:**
- Happy path: each helper is unit-tested (the existing test for `normalizeEntity`'s urgency clamp at `agentBridge.test.ts:282-298` continues to pass).
- Edge case: `clampUrgency(NaN)` returns 2; `clampUrgency(0)` returns 1; `clampUrgency(5)` returns 3.

**Verification:** Add `taskNormalization.test.ts` next to the existing service test files; run the existing `agentBridge.test.ts` U2 tests unchanged.

## System-Wide Impact

- **Interaction graph:** Only the `semanticEngine` prompt + helpers are touched. The AI call pipeline (`geminiService.processAudio`, `workLogExtractor.processWorkLogAudio`) is unaffected because the public signatures of `getSystemPrompt` and `normalizeEntity` are preserved.
- **Error propagation:** The TypeScript helpers continue to swallow invalid values (e.g. urgency NaN → 2). No throw escapes.
- **State lifecycle risks:** None — the rules live in a string and a small module; no persistence.
- **API surface parity:** `getSystemPrompt` adds a parameter; `normalizeEntity`'s signature stays. Callers in the voice / agent path pass through.
- **Integration coverage:** Manual smoke in next release: speak a Voice command that the AI would have previously clamped; observe the AI now produces the clamped value directly.
- **Unchanged invariants:** The four-state Google auth model, the `db.agentInbox` mirror, the `applySemanticResult` voice path, the agent write contract are all untouched. The narrowing in U2 keeps the safety net intact.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Gemini ignores the new prompt rules and outputs invalid values. | The TypeScript helpers clamp the values; the safety net still works. |
| The prompt becomes too long and Gemini drifts on the rules. | The new section is small (~10 lines); the prompt has plenty of headroom in Gemini-3-flash-preview. |
| A future contributor edits the prompt and forgets the TypeScript helper. | A single-line doc comment at each import site references the prompt as the source of truth. |

## Documentation / Operational Notes

- The version bump follows the auto-bump workflow.
- The behavior change is invisible at the API boundary: the same `Task` shape is produced. The change is at the prompt level.
- No new env vars, no new dependencies.

## Sources & References

- Audit origin: agent-native audit on 2026-07-06, recommendation 7 (deferred in the original plan scope boundaries)
- Plan source: `docs/plans/2026-07-06-001-feat-widen-agent-write-contract-plan.md` § Scope Boundaries (rec 7 deferred)
- Related code:
  - `battle-plan/src/services/semanticEngine.ts:1-220`
- `docs/solutions/best-practices/helper-extraction-test-rewriting-2026-07-04.md` (extraction discipline)
