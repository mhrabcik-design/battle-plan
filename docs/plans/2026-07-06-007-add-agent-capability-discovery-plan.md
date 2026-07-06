---
title: Add Agent Capability Discovery
type: feat
status: active
date: 2026-07-06
origin: agent-native audit recommendation 5 from the 2026-07-06 audit (49% overall)
---

# Add Agent Capability Discovery

## Summary

Adds the surfaces that let the user discover what Anu (the AI assistant) can do. The implementation is a four-part change: a first-run onboarding card that explains the agent's three roles (manager / recorder / partner), a self-description card on the existing diagnostic page, capability hints on the relevant existing UI surfaces (voice mic button, suggestions panel, tasks list), and a one-line slash command palette (`/` opens a small list of shortcuts). Closes audit recommendation 5.

## Problem Frame

The audit found that the only agent signal in the UI is the `AI ARCHITEKT` pill in the sidebar (`Sidebar.tsx:77-80`) and a few mentions in suggestion card placeholders. A new user has no way to learn what the agent does, how to interact with it, or what features it touches. The Voice button shows a "Spustit diktování" tooltip; the suggestion panel says "Návrhy od Anu"; but neither tells the user "Anu can create tasks, extract worklogs, and watch your drive folder for new suggestions."

The fix is a small set of additive UI surfaces. No new backend work is needed because all agent capabilities are already implemented (`applySemanticResult`, `processWorkLogAudio`, the suggestion sync). The audit rec explicitly notes the lack of a self-description surface, a hint surface, and an empty-state guide. The plan covers all three.

## Requirements

- R1. A first-run onboarding card appears the first time the user signs in (no previous sign-in record) and explains the agent's three roles in 3-5 lines, with a "Got it" button that dismisses the card.
- R2. The dismissed state is persisted to `db.settings` under a new key (`agent_onboarding_dismissed_at: number | null`). The card reappears if the user explicitly resets the onboarding (a "Show me again" affordance in Settings).
- R3. A "I am Anu" self-description card lives on the existing Diagnostics page (`App.tsx` → "Konfigurace" / "Diagnostika" surface) and lists the agent's three roles plus a one-liner for each. It is shown only when the user navigates to the diagnostic page; it is not a popup.
- R4. Capability hints on the voice mic button: the existing tooltip is extended from "Spustit diktování" to "Spustit diktování — Anu vytvoří task / worklog / nápad podle toho, co řekneš."
- R5. Capability hints on the suggestions page: the existing subtitle "Suggestions panel čte z Anu-BattlePlan složky na Drive" gets a sibling one-liner explaining accept / reject / defer / delete actions.
- R6. A slash command palette opens with `/` typed in any input-free area (e.g. global `keydown` listener); pressing Esc closes it. The palette shows the three roles plus "Open Diagnostics" as a one-click action.
- R7. The onboarding card is suppressed on subsequent sign-ins once dismissed. The dismissal survives a hard refresh (Dexie persistence).
- R8. No change to the AI behavior; the surfaces are pure UI.

## Scope Boundaries

- In scope: a new `OnboardingCard` component, a new `AnuSelfDescription` component (or inline), updates to the voice mic button label, the suggestions subtitle, a new `SlashCommandPalette` component, a Dexie settings key for the dismissal timestamp.
- Out of scope: a chat-style prompt input (the agent is voice-and-suggestion-driven, not chat-driven); re-architecting the sidebar; any agent behavior change.

### Deferred to Follow-Up Work

- A persistent agent-status pill in the header (the existing `AI ARCHITEKT` pill in the sidebar already covers this; expanding to a header pill is cosmetic).
- Per-feature onboarding cards (e.g. "Try the voice" after first login). The plan covers a single one-time onboarding card; per-feature prompts are a larger UX scope.
- A tooltips library (Radix UI or similar) for richer capability hints. Inline `title=` attributes are enough for this iteration.

## Context & Research

### Relevant Code and Patterns

- `battle-plan/src/components/Sidebar.tsx:77-80` — the existing `AI ARCHITEKT` pill that this plan extends indirectly.
- `battle-plan/src/App.tsx:580-587` — the existing debug button at the top of the page that opens the diagnostic view. The self-description card lives on that surface.
- `battle-plan/src/components/WorkLogVoiceBar.tsx:232-253` — the voice mic button where the capability hint is added.
- `battle-plan/src/pages/SuggestionsPage.tsx:355-357` — the existing "Suggestions panel čte z..." subtitle that this plan extends.
- `battle-plan/src/hooks/useGlobalVoiceProcessing.ts` — the voice pipeline that the mic button triggers; no behavior change is needed.
- `battle-plan/src/db.ts:9-77` — `Task` / `Setting` / `Project` / `WorkLog` interfaces; a new setting entry `agent_onboarding_dismissed_at` follows the same shape as the existing settings.

### Institutional Learnings

- `docs/solutions/integration-issues/drive-readiness-diagnostic-states-2026-07-05.md` — three-state diagnostic mapping. The new diagnostic card lives on the same surface and follows the same shape (`/app/diagnostic`).
- `docs/solutions/integration-issues/google-tasks-scope-403-background-fetch-2026-07-06.md` — the agent path is independent of Google auth for non-API surfaces. The new UI surfaces do not require any new API access.
- `docs/solutions/best-practices/helper-extraction-test-rewriting-2026-07-04.md` — when extracting components, the test contract is rewritten first.

### External References

None.

## Key Technical Decisions

- The onboarding dismissal is stored in `db.settings` under a stable key (`agent_onboarding_dismissed_at: number | null`). When the value is a number, the card is hidden. When `null` or missing, the card shows on first sign-in.
- The slash command palette is a global `keydown` listener that ignores the event when an `<input>`, `<textarea>`, or `contenteditable` is focused. This is the standard "command palette" pattern.
- The "I am Anu" card reuses the existing diagnostic surface in `App.tsx:580-587`. It is rendered as a sibling of the existing SyncHealth cards.
- Capability hints on the voice mic and suggestions subtitle are simple `title=` and text-content changes. No new design tokens.

## Open Questions

### Resolved During Planning

- **What are the agent's three roles?** Manager (creates tasks from voice), Recorder (extracts worklogs from voice), Partner (brainstorms ideas). These are already in the existing `getSystemPrompt` in `semanticEngine.ts`. The onboarding card surfaces them as user-readable text.
- **Where does the slash command live?** A new top-level component that listens for `/` and renders a modal. No router change.
- **How is the slash command scope bounded?** Only the four actions: Manager / Recorder / Partner / Open Diagnostics. Adding more is a follow-up.

### Deferred to Implementation

- Whether the slash command palette uses a fixed-position modal or a popover near the caret. Default to fixed-position modal.
- Whether the onboarding card is shown on first sign-in or first app mount. Default to first sign-in (a returning user who already signed in once does not see the card on a hard refresh).

## Implementation Units

### U1. Persist onboarding dismissal in `db.settings`

**Goal:** Add a new setting entry that records the dismissal timestamp.

**Requirements:** R2.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/db.ts`
- Create: `battle-plan/src/services/onboarding.ts`

**Approach:**
- Add a `Setting` interface variant: `'agent_onboarding_dismissed_at' | ...` (extend the string union).
- New helper `isOnboardingDismissed(): Promise<boolean>` reads the setting and returns true if the timestamp is within the last 90 days (so users on a long vacation see the card again).
- New helper `dismissOnboarding(): Promise<void>` stamps the setting with `Date.now()`.

**Patterns to follow:** the existing `db.settings.get` / `db.settings.put` pattern.

**Test scenarios:**
- Happy path: a fresh user has no setting; `isOnboardingDismissed` returns false.
- Happy path: after `dismissOnboarding`, `isOnboardingDismissed` returns true.
- Edge case: a dismissal timestamp older than 90 days returns false.

**Verification:** Add `onboarding.test.ts` next to the existing service test files.

### U2. Onboarding card

**Goal:** Render the first-run onboarding card.

**Requirements:** R1, R2, R7.

**Dependencies:** U1.

**Files:**
- Create: `battle-plan/src/components/OnboardingCard.tsx`
- Modify: `battle-plan/src/App.tsx`

**Approach:**
- New `OnboardingCard` component renders a 3-section card with the agent's three roles, a "Got it" button, and a "Show me again" link in Settings (deferred to a follow-up plan).
- App.tsx renders the card conditionally on `!isOnboardingDismissed()` and `googleAuth.userEmail != null` (signed in).

**Patterns to follow:** the existing card components on the diagnostics page.

**Test scenarios:**
- Happy path: when `isOnboardingDismissed` returns false and the user is signed in, the card is visible.
- Happy path: clicking "Got it" calls `dismissOnboarding` and hides the card.
- Edge case: when `isOnboardingDismissed` returns true, the card is hidden.

**Verification:** A render test (RTL) verifies the visibility and the click handler.

### U3. "I am Anu" self-description card

**Goal:** Render the agent self-description on the existing diagnostic page.

**Requirements:** R3.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/pages/DebugPage.tsx` (or whichever file holds the diagnostic view)
- Create: `battle-plan/src/components/AnuSelfDescription.tsx`

**Approach:**
- New `AnuSelfDescription` component renders the three roles plus a one-liner each.
- Wired into the existing diagnostic surface at `App.tsx:580-587`.

**Patterns to follow:** the existing diagnostic card layout.

**Test scenarios:**
- Happy path: when the diagnostic view is open, the self-description card is visible.

**Verification:** A render test (RTL) verifies the card content.

### U4. Capability hints on the voice mic + suggestions subtitle

**Goal:** Add the existing surfaces' capability hints.

**Requirements:** R4, R5.

**Dependencies:** None.

**Files:**
- Modify: `battle-plan/src/components/WorkLogVoiceBar.tsx`
- Modify: `battle-plan/src/pages/SuggestionsPage.tsx`

**Approach:**
- Update the voice mic button's `title=` attribute from "Spustit diktování" to "Spustit diktování — Anu vytvoří task / worklog / nápad podle toho, co řekneš."
- Update the suggestions page subtitle to add a one-liner explaining accept / reject / defer / delete.

**Patterns to follow:** the existing `title=` usage on the voice mic.

**Test scenarios:**
- Happy path: the voice mic button's `title` includes the new string.
- Happy path: the suggestions page subtitle includes the new one-liner.

**Verification:** A render test (RTL) verifies the text content.

### U5. Slash command palette

**Goal:** A `/` opens a small palette of shortcuts; `Esc` closes it.

**Requirements:** R6.

**Dependencies:** None.

**Files:**
- Create: `battle-plan/src/components/SlashCommandPalette.tsx`
- Modify: `battle-plan/src/App.tsx`

**Approach:**
- Global `keydown` listener on `document` that captures `/` and prevents default when no input is focused.
- Renders a fixed-position modal with four options: Manager / Recorder / Partner / Open Diagnostics. Each option fires a callback (open voice mic, open worklog mic, open suggestions, navigate to diagnostics).
- `Esc` closes the palette.

**Patterns to follow:** the existing modal components in the app.

**Test scenarios:**
- Happy path: pressing `/` opens the palette; pressing `Esc` closes it.
- Happy path: clicking "Open Diagnostics" navigates to the diagnostics page.
- Edge case: pressing `/` while typing in an input does not open the palette.

**Verification:** A render test (RTL) verifies the keyboard handler and the navigation.

## System-Wide Impact

- **Interaction graph:** The onboarding card mounts on first sign-in and unmounts after dismiss; the self-description card mounts on the diagnostic page; the slash command palette mounts on `/` and unmounts on `Esc`. None of these affect the existing agent write path, the polling cadence, or the diagnostics surface itself.
- **Error propagation:** `dismissOnboarding` and `isOnboardingDismissed` are Dexie reads / writes wrapped in `try { ... } catch`; failures are logged and fall through to "show the card" / "do not navigate".
- **State lifecycle risks:** None — the only persistent state is a `db.settings` key.
- **API surface parity:** None.
- **Integration coverage:** Manual smoke in next release: sign in for the first time, see the card; dismiss it; refresh; verify it does not reappear.
- **Unchanged invariants:** The four-state Google auth model, the `db.agentInbox` mirror, the polling cadence, the agent write contract are all untouched. The new surfaces are additive.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The slash command palette intercepts `/` in a non-input field unexpectedly. | The `keydown` listener checks `e.target instanceof HTMLInputElement / HTMLTextAreaElement / HTMLElement with contenteditable` and bails if focused. |
| The onboarding card is shown to returning users on a hard refresh if the dismissal timestamp is older than 90 days. | The plan accepts this as a "long-vacation re-onboarding" feature. The 90-day threshold is tunable. |
| The slash command palette overlaps with an existing `/` shortcut. | Search the codebase for `keydown` listeners; if any conflict, the palette's `keydown` is only attached when no input is focused and only acts on the `/` key. |

## Documentation / Operational Notes

- The version bump follows the auto-bump workflow.
- The visible user-facing change is additive; no existing UI is removed or moved.
- No new env vars, no new dependencies.

## Sources & References

- Audit origin: agent-native audit on 2026-07-06, recommendation 5 (deferred in the original plan scope boundaries)
- Plan source: `docs/plans/2026-07-06-001-feat-widen-agent-write-contract-plan.md` § Scope Boundaries (rec 5 deferred)
- Related code:
  - `battle-plan/src/components/Sidebar.tsx:77-80`
  - `battle-plan/src/components/WorkLogVoiceBar.tsx:232-253`
  - `battle-plan/src/pages/SuggestionsPage.tsx:355-368`
  - `battle-plan/src/db.ts:9-77`
