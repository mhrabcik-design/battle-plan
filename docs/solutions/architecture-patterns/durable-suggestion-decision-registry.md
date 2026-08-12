---
title: Durable suggestion decision registry across Hermes cycles and devices
date: 2026-08-12
category: architecture-patterns
module: Hermes Suggestions
problem_type: architecture_pattern
component: assistant
severity: high
applies_when:
  - An agent may regenerate the same business suggestion with a new proposal ID
  - Suggestion decisions must converge across browsers or devices over Google Drive
  - Task creation and the corresponding terminal agent response must commit atomically
  - Text similarity can suggest a duplicate but is not safe as an automatic suppression key
related_components:
  - IndexedDB suggestion registry
  - Google Drive JSON synchronization
  - Agent Protocol v2 responses
  - Suggestions user interface
tags:
  - hermes
  - suggestions
  - stable-identity
  - idempotency
  - drive-sync
  - decision-registry
  - outbox
  - human-review
---

# Durable suggestion decision registry across Hermes cycles and devices

## Context

A proposal ID identifies one delivery, not the underlying business event. Hermes may describe the same event again in a later cycle under a new `proposal_id`. Deduplication therefore needs separate identities for the recurring subject and for one concrete occurrence.

Agent Protocol v2 requires `subject_id`, `occurrence_key`, and non-empty `source_refs` on proposals, and responses echo the subject and occurrence keys (`docs/agent-protocol/v2/schemas/proposal.schema.json:16`, `docs/agent-protocol/v2/schemas/response.schema.json:16`). BattlePlan persists the identity as a subject, an occurrence, and append-only decisions associated with that occurrence (`battle-plan/src/db.ts:111`, `battle-plan/src/db.ts:123`, `battle-plan/src/db.ts:135`).

## Guidance

### Model delivery, subject, and occurrence separately

- `proposal_id` is one delivery attempt.
- `subject_id` is the durable topic or series, such as monthly VAT work.
- `occurrence_key` is one concrete actionable event, such as VAT for July 2026.
- `source_refs` are the evidence and source scope that support the identity.

When the producer supplies stable subject and occurrence keys, BattlePlan uses them directly. Legacy suggestions fall back to a conservative exact fingerprint derived from normalized category, title, and source scope (`battle-plan/src/utils/suggestionIdentity.ts:59`). The fallback preserves compatibility, but it cannot reliably represent recurring occurrences within one subject.

### Make decision semantics explicit

Terminal decisions are accepted, converted, rejected, and dismissed. Once a terminal decision exists, a later stale defer or reopen cannot make the occurrence actionable again (`battle-plan/src/services/suggestionRegistry.ts:112`). Comments are durable but nonterminal. A defer suppresses only until its finite `deferUntil`; protocol responses require `defer_until` when the decision is deferred (`docs/agent-protocol/v2/schemas/response.schema.json:21`, `docs/agent-protocol/v2/schemas/response.schema.json:28`).

Decision rows are append-only by identity. If two devices present the same decision ID with different immutable content, synchronization fails closed instead of silently selecting one version.

### Reserve fuzzy matching for human review

Exact occurrence identity may suppress a terminal or currently deferred occurrence. Similar text is only a candidate signal. Batch resolution returns `possible-duplicate`, skips other occurrences that already belong to the same stable subject, and keeps genuinely recurring work actionable (`battle-plan/src/services/suggestionRegistry.ts:528`).

The UI displays "Možná duplicita" with explicit "Je to stejné" and "Je to nové" actions (`battle-plan/src/components/SuggestionCard.tsx:244`). Confirming sameness creates an occurrence alias while retaining historical rows; confirming distinctness records an explicit subject relationship (`battle-plan/src/services/suggestionRegistry.ts:713`, `battle-plan/src/services/suggestionRegistry.ts:754`). Fuzzy similarity alone never hides work.

### Converge Drive journals before removing duplicate files

The decision registry is synchronized as `agent-suggestion-decisions.json`. The synchronizer reads every same-named Drive file discovered by the bounded Drive listing, validates and merges those snapshots, then writes one deterministic canonical file with an ETag (`battle-plan/src/services/suggestionRegistrySync.ts:190`). A missing ETag fails closed because an unconditional overwrite would be unsafe.

After writing, it rereads and merges every discovered candidate. Duplicate files are trashed only after the canonical file is verified to contain every pending local decision. The same rule protects the replies journal (`battle-plan/src/services/suggestionsSync.ts:229`). Drive discovery returns up to 1,000 matching files in stable ID order, and cleanup targets one exact file ID (`battle-plan/src/services/driveJsonStore.ts:472`, `battle-plan/src/services/driveJsonStore.ts:507`).

### Commit the domain effect and producer response together

Task conversion runs in one Dexie transaction across the task, subject, occurrence, decision, and protocol-outbox tables (`battle-plan/src/services/suggestionRegistry.ts:635`). A protocol-native decision queues a response that repeats the proposal, subject, and occurrence identity and includes defer, comment, or task information when applicable (`battle-plan/src/services/suggestionRegistry.ts:211`).

For a protocol-native proposal, the local mutation can therefore be retried safely after a crash: either the task, decision, and producer response all commit, or none do. Legacy proposals still commit the task and decision atomically but continue to use the legacy reply mirror. The durable outbox preserves protocol-native responses for the future protocol publication stage.

## Why This Matters

The registry answers "was this business occurrence processed?" rather than merely "was this proposal ID seen?". That prevents repeated approval after Hermes regenerates a proposal while still allowing a new month or other new occurrence under the same subject.

Append-only decisions and verified multi-file convergence preserve the answer across devices. For protocol-native proposals, atomic conversion avoids both split states: a task without a decision and a decision without a durable response for Hermes. Human-only fuzzy resolution avoids the opposite failure of silently hiding new work with similar wording.

## When to Apply

- An agent periodically regenerates recommendations, tasks, reminders, or events.
- Delivery IDs are not stable across producer cycles.
- One subject legitimately recurs through multiple occurrences.
- Decisions must converge through a shared whole-file store across devices.
- Approximate semantic matching could hide consequential work.

## Examples

For recurring VAT work, Hermes can keep `subject_id: tax.vat-series` while using `occurrence_key: tax.vat-2026-07` and `occurrence_key: tax.vat-2026-08`. A July retry with a new proposal ID resolves to the terminal July decision; August remains open.

Two similarly worded suggestions may exceed the similarity threshold, but BattlePlan presents a warning until the user confirms "Je to stejné". Selecting "Je to nové" records a durable distinction so the warning does not return.

## Prevention

Keep regression coverage for these invariants:

- a terminal decision suppresses the same occurrence under another proposal ID;
- comments remain nonterminal and defers expire;
- a later stale defer cannot reopen a terminal occurrence;
- a new occurrence under the same subject remains actionable;
- fuzzy matches require explicit same/new confirmation;
- task conversion, the decision, and the protocol response roll back together;
- concurrent first registry and reply files converge without losing either device's data;
- registry synchronization rejects malformed journals, reused decision IDs with conflicting immutable payloads, and ETag-less updates; the page does not expose proposal actions while that registry is unavailable.

Representative tests live in `battle-plan/src/services/suggestionRegistry.test.ts`, `battle-plan/src/services/suggestionRegistrySync.test.ts`, and `battle-plan/src/services/suggestionsSync.test.ts`.

## Related

- [Durable ledger for at-least-once agent commands](durable-agent-protocol-ledger.md)
- [Cross-device WorkLog sync duplicates](../database-issues/cross-device-worklog-sync-duplicates.md)
- [Durable WorkLog project catalog](../design-patterns/worklog-project-catalog-management.md)
- [Drive readiness diagnostic states](../integration-issues/drive-readiness-diagnostic-states-2026-07-05.md)
