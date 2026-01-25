# Task: Update Mobile Sync and UI

User reported issues with the mobile version of Battle Plan after the Desktop-First transformation.
Specifically:
- Settings disappeared on mobile.
- Synchronization is not working.
- Saving issues.
- Mobile UI needs to match the new PC features (Timeline, Focus Mode).

## 1. Analysis of Current Sync Logic
- `checkSync` (auto-restore) only runs if `tasks` count is 0. This is too restrictive.
- `uiScale` (Font Slider) is only in `localStorage`, not synced.
- `lastSync` and `google_access_token` are in `localStorage`.
- Auto-backup debounces 10 seconds and overwrites the cloud file with local data. This can lead to data loss if multiple devices are used simultaneously without proper merging.

## 2. Proposed Fixes

### A. Settings & Sync
- [ ] **Sync UI Scale:** Move `uiScale` from `localStorage` to `db.settings` so it syncs via Google Drive.
- [ ] **Smarter Auto-Restore:** If the application is signed in but has no API Key or very few tasks, suggest or auto-trigger a restore if cloud data is newer.
- [ ] **Manual Sync Visibility:** Add a sync indicator/button to the mobile view (currently only in Desktop sidebar or Settings modal).
- [ ] **Timestamp-based Merge (Optional/Future):** For now, improve the overwrite logic to at least respect `timestamp` in the payload.

### B. Mobile UI Transformation
- [ ] **Mobile Premium Look:** Update the mobile navigation and header to match the new "Professional Office" style.
- [ ] **Focus Mode Mobile Fix:** Ensure the editing window is truly fullscreen on mobile without the `md:left-64` offset (verified: it uses `md:left-64` and `left-0` isn't explicit but `inset-0` is used).
- [ ] **Timeline Mobile Polish:** The week view currently has `min-w-[1000px]`. This is fine for scrolling, but ensure the day headers are sticky and clear.

### C. Urgency & Saving
- [ ] Verify that the 3-level urgency (1, 2, 3) is consistent everywhere and doesn't get reset.
- [ ] Fix potential "saving" issues where `db.tasks.update` might mismatch with the synced payload schema.

## 3. Implementation Steps

1. **Phase 1: Sync & Settings**
   - Update `App.tsx` to handle `uiScale` via `db.settings`.
   - Update `checkSync` to be more proactive if settings are missing.
   - Ensure all settings (API Key, Model, UI Scale) are correctly synced.

2. **Phase 2: Mobile UI Updates**
   - Redesign mobile navigation bar.
   - Refine Focus Mode CSS for mobile.
   - Ensure Timeline view is readable on small screens.

3. **Phase 3: Verification**
   - Test sync between "simulated" PC and Mobile views.
   - Verify urgency levels.
   - Verify no settings data loss.
