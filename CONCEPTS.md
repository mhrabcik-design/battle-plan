# Concepts

## WorkLogs

### Project
A durable work assignment that is created once and reused across WorkLogs for as long as the work continues.

Only active projects are available for new WorkLogs. Archived projects keep their identity and remain visible through historical WorkLogs.

Canonical names and aliases share one project identity namespace. Normalization reconciles safe spacing and letter-case variants automatically; a user can explicitly merge semantically equivalent but differently named rows by selecting a source and the active survivor.

Absorbed and previous names remain on the survivor as synchronized alias tombstones. They prevent an old Drive payload or later create/rename from recreating the removed identity. WorkLogs move to the survivor through `projectId` and retain their historical `projectName` snapshot for persistence and sync, while overview surfaces resolve the current canonical project name and color. Ambiguous alias ownership fails closed, and semantic merge remains a human-only action.

### WorkLog
A record of completed work on a project, distinct from a task or meeting because it represents labor that can be reported by date, project, people, and hours.

Each WorkLog has a portable sync identity that remains stable between devices. Content-equivalent WorkLogs remain separate records unless a person explicitly confirms that they are copies to merge.

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

### Agent Collaboration Protocol
A versioned, paired message contract through which an external agent can propose work, request allowlisted domain mutations, receive explicit outcomes, and consume safe BattlePlan change events.

Protocol messages have stable identities, runtime-validated schemas, verified producers, explicit target receivers, and separate command, result, proposal, response, event, and snapshot semantics. Google Drive is a transport for these messages, not the source of domain truth.

### Command Receipt
The durable local record that proves BattlePlan has seen a protocol command and owns its lifecycle from receipt through approval, application, rejection, expiry, or recovery.

A receipt uses the command identity and payload digest as its idempotency boundary. Replaying the same command returns the recorded lifecycle, while reusing the identity for different content fails closed.

### Protocol Outbox
The durable queue written in the same local transaction as a domain mutation and its change events.

Drive publication and other external effects run after that transaction and may retry independently. This prevents a network failure from causing BattlePlan to repeat a committed domain mutation.

### Change Event Stream
An ordered, per-producer sequence of safe domain-change projections that lets Hermes or another paired consumer update its context without reading BattlePlan's private local database.

Consumers advance their cursor only after durable ingestion. A sequence gap or lost cursor requires a protocol snapshot before incremental consumption resumes.

Snapshot recovery resumes only from a cryptographically authenticated snapshot whose projection installation and cursor advancement commit atomically. A failed or incomplete installation leaves the consumer in snapshot-required state.

### Shared Audio AI Pipeline
The browser-side voice-processing layer shared by task voice and WorkLog voice flows for recording, audio normalization, Gemini request preparation, retry/error handling, and missing-key messaging.

The shared pipeline does not merge domain logic: task semantic editing and WorkLog batch extraction keep separate prompts, result types, and validation rules.

### Voice Proposal Lifecycle
The full lifecycle from browser microphone recording through AI extraction, proposal review, save, cancel, navigation away, and recorder unmount.

Terminal actions in this lifecycle must clean up both visible proposal UI and source recorder state such as audio blobs, processing guards, timers, audio contexts, media recorder handlers, and media tracks.

A shared voice entry point remains owned by the selected voice domain even while its page-local controller is not ready. During that interval it fails closed instead of falling back to a recorder from another domain.

## Agent Suggestions

### Suggestion Subject
The durable topic or recurring series that several concrete suggestion occurrences may belong to across producer cycles.

### Suggestion Occurrence
One concrete actionable event within a Suggestion Subject, independent of how many times the producer delivers it as a proposal.

A terminal human decision permanently resolves that exact occurrence. A new occurrence under the same subject remains actionable.

### Suggestion Decision Registry
The append-only, synchronized record of human decisions keyed by Suggestion Occurrence rather than by one proposal delivery.

Exact terminal decisions suppress an occurrence across later cycles and devices. Comments remain nonterminal, deferrals expire, and approximate text similarity requires a human same-or-new decision.
