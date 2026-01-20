# PLAN: Export Feature & Weekly View Refinement - [COMPLETED ✅]

This plan covers adding an export functionality for tasks and meetings, formatted specifically for emails, and refining the weekly overview to skip completed items.

## 1. ANALYSIS & GOALS [DONE]
- **Export Goal:** Beautiful text block formatted for Gmail. ✅
- **UI Element:** Mail icon added to card footer/header. ✅
- **Weekly View Goal:** Hide completed items for high-density focus. ✅

## 2. TASK BREAKDOWN [DONE]

### Phase 1: Logic & Filtering ✅
- **Task 1: Filter Completed in Weekly View** ✅
  - Modified `useLiveQuery` for 'week' mode to filter out `.status === 'completed'`.
  - Removed redundant task list from the bottom of the weekly view for cleaner UI.

### Phase 2: Export Functionality ✅
- **Task 2: Implement Formatting Helper** ✅
  - Created `handleExport` with structured templates for title, duration, subtasks, and notes.
- **Task 3: Add `handleExport` Action** ✅
  - Integrated `mailto:` with URI encoding for subject and body.

### Phase 3: UI Implementation ✅
- **Task 4: Card UI Update** ✅
  - Added `Mail` icon to both main task cards and weekly row buttons.
  - Implemented stopPropagation to prevent modal opening when clicking export.

## 6. PHASE X: VERIFICATION [DONE]
- [x] Weekly view skips completed items.
- [x] Export button exists on all relevant cards.
- [x] Export content is formatted correctly and readable.
- [x] `mailto:` link correctly escapes special characters (Czech diacritics).
- [x] No lint errors.
