# Plan: Redefine Urgency Levels (1-3)

Redefine task urgency levels from a 5-point scale to a 3-point scale, update AI processing logic, and adjust UI components.

## Phase 1: Data Model Update
- [x] Update `Task` interface in `db.ts` to restrict urgency to `1 | 2 | 3`.

## Phase 2: AI Logic Update
- [x] Update `systemPrompt` in `geminiService.ts` to reflect 3-level scale.
- [x] Update default value in `handleProcessAudio` in `App.tsx` from 3 to 2.

## Phase 3: UI Adjustments
- [x] Update `getUrgencyColor` in `App.tsx` for levels 1-3.
- [x] Update Urgency slider in `App.tsx` (Focus Mode) to `min="1" max="3"`.
- [x] Update display labels for urgency.

## Verification Criteria
- [x] New tasks created via voice have default urgency 2.
- [x] Tasks mentioned as "urgent" have urgency 3.
- [x] Tasks mentioned as "without urgency" have urgency 1.
- [x] Focus Mode UI shows 1-3 scale.
- [x] Colors are correctly applied to the 3 levels.
