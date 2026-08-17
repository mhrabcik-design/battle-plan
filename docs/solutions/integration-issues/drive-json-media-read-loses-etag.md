---
title: Drive JSON media reads lose the concurrency ETag
date: 2026-08-17
category: integration-issues
module: Google Drive JSON synchronization
problem_type: integration_issue
component: drive-sync
symptoms:
  - "Suggestions sync reports that the decision registry has no ETag for a safe concurrent write"
  - "The registry is readable but publishing a pending decision fails closed on every polling cycle"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - "Suggestion decision registry"
  - "Reply journal"
  - "WorkLogs synchronization"
tags:
  - "google-drive"
  - "etag"
  - "optimistic-concurrency"
  - "gapi"
  - "suggestions-sync"
---

# Drive JSON media reads lose the concurrency ETag

## Problem

The shared Drive JSON store downloaded file content through browser `fetch`. In the deployed GitHub Pages app, the JSON body remained readable but the response ETag was not available to the application. Concurrency-sensitive synchronizers then correctly refused to overwrite the existing file.

## Symptoms

- Diagnostics repeatedly showed `Registr rozhodnutí nemá ETag pro bezpečný souběžný zápis.`
- Google authentication and unrelated Drive reads could remain healthy, while Suggestions sync failed once per polling cycle.
- The failure appeared only when the domain service needed to publish a pending decision; a read without a pending write could look successful.

## What Didn't Work

- Removing the missing-ETag guard would turn a visible sync failure into a silent lost-update risk. The guard is a safety invariant, not the defect.
- Drive API v3's `version`, `modifiedTime`, `md5Checksum`, and `headRevisionId` are not HTTP entity tags and cannot safely replace `If-Match`.
- Reading metadata separately after downloading content can pair a newer validator with older JSON. A later conditional write could then overwrite the intervening change.
- `If-Match: *` checks only that a resource exists; it does not protect a read-modify-write cycle from another client's update.

## Solution

The first attempted fix moved the media read from browser `fetch` to `gapi.client.request` and parsed a response ETag when present. Production version 4.3.52 proved that this was not a dependable contract: the same missing-ETag failure remained. Drive API v3 documents `alt=media` as a content download, not as a source of a browser-readable concurrency validator.

The suggestion decision registry therefore no longer performs a mutable whole-file update. When local decisions are pending, it creates a new complete `agent-suggestion-decisions.json` snapshot with `createOnly: true`, rereads every exact-name file, merges them through the existing conflict checks, and marks the pending decisions published only after the merged union contains them. It never chooses a canonical file, sends `If-Match`, retries a 412, or trashes duplicates.

The missing-ETag guard remains correct for mutable aggregate writers that have not yet migrated. WorkLogs, the reply journal, and other writers must either adopt their own immutable protocol or move compare-and-swap to a trusted server; they must not copy the registry change without preserving their domain-specific merge and deletion semantics.

## Why This Works

Concurrent devices create separate snapshots instead of competing to replace one blob. The registry already uses stable decision IDs, immutable decision payload checks, and deterministic union merges across all matching files. Replayed or duplicated snapshots are therefore idempotent, while contradictory records still fail closed.

The repair is intentionally domain-level. A generic transport cannot invent safe merge semantics for replies or WorkLog tombstones. The registry can use create-only snapshots because its complete snapshot contains decisions plus their subject and occurrence identity graph.

## Prevention

- Do not treat a GAPI media-response ETag as a supported production contract merely because a mock exposes one.
- Keep tests proving that registry publication succeeds without an ETag, creates rather than updates, verifies the merged union, and never trashes duplicate snapshots.
- Never derive `If-Match` from a Drive metadata field that is not an HTTP ETag.
- Preserve fail-closed missing-validator guards for mutable writers until each domain has a safe replacement protocol.
- Run an authenticated GitHub Pages smoke test that publishes a decision and remains healthy across two polling intervals.

## Related Issues

- [Durable suggestion decision registry](../architecture-patterns/durable-suggestion-decision-registry.md)
- [Drive readiness diagnostic states](drive-readiness-diagnostic-states-2026-07-05.md)
- [RFC 9110: If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)
