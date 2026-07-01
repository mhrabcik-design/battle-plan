# Concepts

## WorkLogs

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

### Shared Audio AI Pipeline
The browser-side voice-processing layer shared by task voice and WorkLog voice flows for recording, audio normalization, Gemini request preparation, retry/error handling, and missing-key messaging.

The shared pipeline does not merge domain logic: task semantic editing and WorkLog batch extraction keep separate prompts, result types, and validation rules.
