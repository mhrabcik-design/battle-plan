# Concepts

## WorkLogs

### Project
A durable work assignment that is created once and reused across WorkLogs for as long as the work continues.

Only active projects are available for new WorkLogs. Archived projects keep their identity and remain visible through historical WorkLogs.

One normalized project name means one project identity, even when older records differ only by spaces, letter case, local numeric ID, or color. Database upgrades and Drive merges reconcile those variants to one catalog row while WorkLogs retain their historical name snapshot.

### WorkLog
A record of completed work on a project, distinct from a task or meeting because it represents labor that can be reported by date, project, people, and hours.

### Person-Hours
The reportable labor total for crew work: the number of people multiplied by the hours per person.

Person-hours can exceed a single person's daily hours when the entry records a crew. In those cases the WorkLog should preserve calculation metadata so the total remains explainable.

### Batch Voice Extraction
The WorkLog voice-capture flow where one natural-language dictation produces several proposed daily WorkLogs for review before anything is saved.

Batch voice extraction should expose assumptions, relative-date interpretation, anonymous worker labels, and any correction applied to a specific date.

## Runtime Traceability

### Build Identity
A single visible description of the running app build: app version, build time, commit identifier when available, runtime origin, and deployment channel.

Build identity exists to prevent confusion between local dev, GitHub Pages, mobile, and desktop app surfaces during testing.

### Sync Diagnostics
A scan-friendly view of sync health split by subsystem, such as Google auth, Tasks sync, WorkLogs sync, and Suggestions sync.

Sync diagnostics should expose status, last success, and high-level errors without exposing tokens, raw Drive payloads, or raw audio.

### Shared Drive JSON Store
The browser-side Drive persistence layer for small JSON files in the shared BattlePlan folder, such as task backup data, WorkLogs data, suggestions, replies, and agent pending writes.

The shared store owns folder lookup, cached folder identity, file lookup, JSON download, and multipart upload mechanics. Domain services still own payload shape, merge rules, diagnostics, and user-facing error meaning.

### Shared Audio AI Pipeline
The browser-side voice-processing layer shared by task voice and WorkLog voice flows for recording, audio normalization, Gemini request preparation, retry/error handling, and missing-key messaging.

The shared pipeline does not merge domain logic: task semantic editing and WorkLog batch extraction keep separate prompts, result types, and validation rules.

### Voice Proposal Lifecycle
The full lifecycle from browser microphone recording through AI extraction, proposal review, save, cancel, navigation away, and recorder unmount.

Terminal actions in this lifecycle must clean up both visible proposal UI and source recorder state such as audio blobs, processing guards, timers, audio contexts, media recorder handlers, and media tracks.

A shared voice entry point remains owned by the selected voice domain even while its page-local controller is not ready. During that interval it fails closed instead of falling back to a recorder from another domain.
