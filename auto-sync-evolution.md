# Task: Auto-Sync Evolution (Timestamp-driven)

Goal: Implement a "Newer Wins" synchronization strategy that triggers automatically when the app becomes active, ensuring seamless transition between PC and Mobile.

## 1. Analysis of Current State
- `checkSync` only runs on mount.
- `last_drive_sync_ts` is used but `checkSync` has restrictive conditions (`localCount <= 1`).
- Auto-backup has a 10s debounce, which is too slow for "immediate" device switching.

## 2. Proposed Changes

### A. Core Sync Logic (`App.tsx`)
- [ ] **Immediate Sync on Focus:** Add a listener for `visibilitychange`. When `document.visibilityState === 'visible'`, trigger `checkSync`.
- [ ] **Relax Restore Conditions:** In `checkSync`, if `cloudTimestamp > lastLocalSyncTs`, perform a restore even if `localCount > 1`. 
- [ ] **Fast Backup:** Reduce the `auto-backup` timeout from 10,000ms to 3,000ms.
- [ ] **Sync Marker Reliability:** Ensure `last_drive_sync_ts` is always updated after both successful upload and successful download.

### B. UI & Feedback
- [ ] **Silent Update Flag:** Implement a minor loading state or subtle toast ("Data aktualizována z cloudu") to inform the user that a sync just happened.

## 3. Implementation Steps

1. **Phase 1: Sync Triggering**
   - Add `useEffect` with `visibilitychange` listener.
   - Refactor `checkSync` into a memoized callback or a standalone function for reuse.

2. **Phase 2: Logic Refinement**
   - Update comparison logic: `if (cloudTimestamp > lastLocalSyncTs) -> RESTORE`.
   - Update backup debounce: `10000 -> 3000`.

3. **Phase 3: Verification**
   - Test "PC Save -> Mobile Wake -> Automatic Load" sequence.
   - Verify that data is not lost if devices are swapped quickly.

## 4. Success Criteria
- [ ] Swapping from PC to Mobile automatically loads the latest tasks within 3 seconds of opening the app.
- [ ] Manual refresh is no longer required.
- [ ] No duplicate tasks created during the sync process.
