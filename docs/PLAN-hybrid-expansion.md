# Project Plan: Hybrid Expansion (Weekly Calendar, Subtasks & Notes) - [COMPLETED ✅]

This plan outlines the implementation of the Hybrid Expansion phase, focusing on extending the data model, enhancing AI processing for subtasks and notes, and introducing a weekly calendar view.

## Phase 1: Data Model & AI Foundation [DONE]

Goal: Prepare the database and AI prompt for subtasks, progress, and internal notes.

- **Task 1.1: Database Schema Update** ✅
  - Updated `db.ts` to include `subTasks`, `internalNotes`, and `progress`.
- **Task 1.2: AI Prompt Refinement** ✅
  - Updated `geminiService.ts` system prompt to extract sub-tasks and internal notes.
- **Task 1.3: Verification** ✅
  - Confirmed AI populates the new schema correctly via audio recording.

## Phase 2: Weekly Calendar View [DONE]

Goal: Implement an organic weekly overview with navigation capability.

- **Task 2.1: Calendar Logic** ✅
  - Implemented `getWeekDays` utility for Mon-Sun calculation.
- **Task 2.2: Calendar UI (7-Day Overview)** ✅
  - Created a row-based layout for the 7 days of the week.
- **Task 2.3: Integration** ✅
  - Implemented filtering for specific days in the weekly overview.

## Phase 3: Enhanced Task Interaction [DONE]

Goal: Add subtasks, internal notes, and progress slider to the UI.

- **Task 3.1: Task Card Upgrade** ✅
  - Added visual progress indicators and subtask previews.
- **Task 3.2: Detailed Interaction Modal** ✅
  - Full edit modal with subtask checklists and internal notes management.
- **Task 3.3: Visual Polish** ✅
  - Color-coding for meetings (orange) vs tasks (indigo).

## Verification Checklist

- [x] AI correctly extracts subtasks from a single audio recording.
- [x] AI correctly appends meeting notes to `internalNotes`.
- [x] The user can navigate between weeks in the calendar view.
- [x] Completed subtasks update the progress bar automatically.
- [x] Manual override of progress slider works.
- [x] Tasks/Meetings are color-coded correctly.
- [ ] Completed tasks (>30 days) are auto-deleted. (Optional / Future)
