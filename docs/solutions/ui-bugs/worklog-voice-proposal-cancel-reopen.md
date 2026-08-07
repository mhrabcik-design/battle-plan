---
title: WorkLog Voice Proposal Cancel Reopen
date: 2026-07-03
category: docs/solutions/ui-bugs
module: WorkLogs voice recording
problem_type: ui_bug
component: assistant
symptoms:
  - WorkLog voice proposal closes after Cancel and immediately opens again.
  - The floating microphone on the Work tab can route through the correct WorkLog flow but still leave stale proposal state behind.
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components:
  - Shared Audio AI Pipeline
  - WorkLogVoiceBar
  - WorkLogVoiceConfirm
tags: [worklogs, voice-recording, recorder-state, modal-cancel, floating-mic]
---

# WorkLog Voice Proposal Cancel Reopen

## Problem

The Work tab voice flow could reopen a cancelled WorkLog proposal immediately after the user pressed `Zrusit`.
The visible modal state was cleared, but the audio recorder state that produced the proposal was not always cleared with it.

This showed up after routing the Work tab's floating microphone into the WorkLog recorder: the UI entry point was now correct, but the cancel path still treated the proposal as a pure modal concern rather than as the tail of an audio-processing pipeline.

## Symptoms

- Pressing `Zrusit` in `WorkLogVoiceConfirm` closed the proposal window and then reopened it.
- The user could not reliably skip a dictated WorkLog proposal.
- The bug appeared after a successful recording and extraction, not during microphone startup.
- The problem affected WorkLog voice proposals, especially through the Work tab recorder path.

## What Didn't Work

- Clearing only `extracted` or `workLogExtracted` was not enough.
  That hides the confirmation UI, but it does not invalidate the audio source state that triggered proposal creation.
- Treating the floating microphone as just another button was not enough.
  The Work tab button must delegate into the WorkLog domain recorder, and every terminal action in that domain recorder must clean up the recorder lifecycle.
- Fixing recorder unmount cleanup helped with navigation leaks, but it did not address the explicit cancel path while the component remained mounted.

## Solution

Make cancel a terminal action for the whole voice proposal lifecycle.
When a user cancels a WorkLog voice proposal, clear the modal state and the recorder's audio buffer together.

In `battle-plan/src/components/worklogs/WorkLogVoiceBar.tsx`, the cancel handler now resets the proposal, manual-project state, pending audio, and processing guard:

```ts
const handleCancelled = useCallback(() => {
    setExtracted(null);
    setManualProjectRequired(false);
    clearAudio();
    processingRef.current = false;
}, [clearAudio]);
```

The confirmation component receives that handler directly:

```tsx
<WorkLogVoiceConfirm
    extracted={extracted}
    onConfirmed={handleConfirmed}
    onCancelled={handleCancelled}
/>
```

The App-level fallback confirmation path received the same defensive cleanup:

```tsx
onCancelled={() => {
  setWorkLogExtracted(null);
  clearAudio();
  isProcessingRef.current = false;
}}
```

This fix shipped with a visible patch bump to `4.3.6`, so the user could distinguish it from the earlier `4.3.5` floating-mic routing fix.

## Why This Works

`WorkLogVoiceConfirm` is not the source of truth for the voice proposal.
It is only the review UI for data produced by `useAudioRecorder` and `processWorkLogAudio`.

The recorder hook exposes `audioBlob`, and the WorkLog voice bar processes that blob in an effect.
If cancel only removes the review UI, stale or not-yet-cleared audio state can still cause the processing path to re-materialize the same proposal.
Clearing the audio buffer with `clearAudio()` makes the cancel action consume and discard the pending recording instead of leaving it available for another render/effect pass.

The same principle applies to route changes and unmounts.
`useAudioRecorder` now closes timers, handlers, audio context, media recorder, and media tracks on unmount so a Work-tab recorder cannot keep a microphone stream alive after its component disappears.

## Prevention

- Treat `Cancel`, `Save`, navigation away, and unmount as lifecycle exits for voice flows, not just UI events.
- When dismissing AI-generated proposals, clear both the rendered proposal state and the source state that produced it (`audioBlob`, processing guards, pending recorder state).
- Keep task voice and WorkLog voice domain logic separate, but share low-level recorder cleanup guarantees in `useAudioRecorder`.
- When the WorkLogs page loads lazily, derive microphone ownership from the selected WorkLogs route. Until its page-local controller registers, disable the shared microphone and fail closed instead of falling through to the general recorder.
- Browser-test the whole terminal path for voice features: start recording, produce proposal, cancel, and confirm that no proposal reopens.
- Bump the visible patch version for production fixes that users need to distinguish while testing on GitHub Pages, mobile, and desktop.

## Related Issues

- Related pattern: `docs/solutions/design-patterns/worklog-batch-person-hour-extraction.md`
- Lazy-page lifecycle pattern: `docs/solutions/architecture-patterns/lazy-page-lifecycle-boundaries.md`
- PR: `https://github.com/mhrabcik-design/battle-plan/pull/10`
- Production fix commit: `6870f64 fix(worklogs): dismiss cancelled voice proposals`
