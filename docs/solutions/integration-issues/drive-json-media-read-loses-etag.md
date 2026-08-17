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

Use the application's authenticated GAPI request surface for the media GET and extract both the parsed JSON and the response header from that single response. The store now requests `/drive/v3/files/{id}?alt=media&supportsAllDrives=true`, parses either GAPI's `result` or raw `body`, and performs a case-insensitive header lookup (`battle-plan/src/services/driveJsonStore.ts:523`).

Only a syntactically strong quoted ETag crosses the generic store boundary. Empty and weak validators remain absent, and the exact strong value—including its quotes—is preserved for the later `If-Match` request (`battle-plan/src/services/driveJsonStore.ts:116`, `battle-plan/src/services/driveJsonStore.ts:123`). Non-success responses and transport rejections become structured read errors rather than missing-file or empty-data results.

The domain guards remain unchanged. Registry publication still retries after a stale conditional revision and still performs zero writes when an existing registry has no ETag (`battle-plan/src/services/suggestionRegistrySync.test.ts:126`, `battle-plan/src/services/suggestionRegistrySync.test.ts:140`).

## Why This Works

The precondition now belongs to the same Drive response revision as the JSON being merged. A concurrent update after that read makes the old validator stale, so Drive can reject the conditional update and the domain service can reread and merge rather than overwrite.

The fix is intentionally transport-level because the same store supplies validators to the suggestion registry, reply journal, and WorkLogs synchronization. Keeping validator extraction in one place restores the input expected by each consumer without weakening their different retry and verification protocols.

Google Drive API v3 does not expose an `etag` field in the `File` JSON resource and does not explicitly document every conditional-update detail used here. Treat browser-visible strong ETags and stale-`If-Match` rejection as a release contract to smoke-test; if either disappears, fail closed and move compare-and-swap to a trusted server or adopt an immutable append-only protocol.

## Prevention

- Regression-test the real transport boundary: assert that media reads use GAPI, preserve a mixed-case strong ETag exactly, parse both `result` and `body`, and reject empty or weak validators (`battle-plan/src/services/driveJsonStore.test.ts:504`).
- Keep at least one test proving that a missing validator causes zero writes and another proving that HTTP 412 triggers a reread/merge path.
- Never derive `If-Match` from a Drive metadata field that is not an HTTP ETag.
- Keep JSON and validator acquisition in one response; avoid metadata-after-content sequences.
- Run an authenticated browser smoke test for ETag visibility and stale-write rejection before releasing changes to this transport.

## Related Issues

- [Durable suggestion decision registry](../architecture-patterns/durable-suggestion-decision-registry.md)
- [Drive readiness diagnostic states](drive-readiness-diagnostic-states-2026-07-05.md)
- [RFC 9110: If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)
