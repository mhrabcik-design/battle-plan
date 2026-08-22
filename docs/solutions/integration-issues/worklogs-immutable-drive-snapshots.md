---
title: WorkLogs sync cannot depend on browser-readable Drive ETags
date: 2026-08-22
category: integration-issues
module: WorkLogs Drive synchronization
problem_type: integration_issue
component: drive-sync
symptoms:
  - "WorkLogs backup repeatedly remains stale although Google authentication is healthy"
  - "An existing WorkLogs or tombstone file cannot be updated because its media response exposes no ETag"
  - "Diagnostics show the last successful time as if it were the current healthy state"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - "WorkLog deletion tombstones"
  - "Sync diagnostics"
tags:
  - "google-drive"
  - "worklogs"
  - "immutable-snapshots"
  - "etag"
  - "concurrency"
  - "diagnostics"
---

# WorkLogs sync cannot depend on browser-readable Drive ETags

## Problem

The deployed browser can read Drive JSON bodies without receiving a usable HTTP ETag. The old WorkLogs read-modify-write flow therefore failed closed before updating `work_logs_data.json` or `work_log_deletion_tombstones.json`, even while authentication and ordinary reads remained healthy.

## Symptoms

- WorkLogs backup repeatedly reports that an existing file has no ETag for a safe concurrent write.
- Google authentication remains healthy while WorkLogs synchronization never advances.
- The diagnostic card can retain an old successful timestamp after a later publication failure.

## What Didn't Work

- Removing the ETag guard would allow silent lost updates.
- Drive metadata fields such as `version`, `modifiedTime`, or `md5Checksum` are not safe replacements for an HTTP entity tag.
- Retrying the same mutable update cannot recover a validator that the browser never receives.

## Solution

WorkLogs now publishes complete, create-only snapshots and verifies the merged Drive state before reporting success. The deletion journal is published and verified first, so a stale device cannot restore a confirmed duplicate while the WorkLogs snapshot is still converging.

```ts
await drive.writeJsonFile(
    WORKLOGS_FILENAME,
    fileContent,
    null,
    { createOnly: true },
);
published = await readPublishedState();
if (containsPublishedPayload(published, expected)) {
    return { kind: 'published', timestamp };
}
```

The verifier reads every exact-name snapshot, groups WorkLogs by portable sync identity, matches projects by public identity or normalized aliases, and accepts only an unambiguous version at least as new as the expected record. Tombstones are monotonic: a compatible newer deletion satisfies verification, while contradictory identity fails closed.

Publication returns a discriminated result instead of collapsing every failure to `false` or `null`. The app maps store, read, verification, and unexpected failures to an error state with `lastError`; an old successful timestamp is labeled as the last success rather than current `OK`.

Suggestions diagnostics follow the same truthfulness rule without changing Hermes files: the durable decision registry, the producer status mirror, and the reply mirror are reported as separate outcomes.

## Why This Works

Concurrent devices no longer compete to overwrite one mutable blob. Each device adds a snapshot, then success depends on observing a conflict-checked union that contains its intended WorkLogs, projects, and deletion records. A lost create response is safe because the reread can prove that the snapshot already exists, and an idempotent retry does not need to replace or trash another device's file.

The solution stays domain-specific. The shared Drive store only creates and reads JSON files; WorkLogs owns portable identity, project reconciliation, tombstone ordering, ambiguity checks, and diagnostic meaning.

## Prevention

- Keep tests that publish successfully without ETags and assert create-only writes with no `If-Match` or duplicate cleanup.
- Test lost create responses, contradictory equal-version records, tombstone-first ordering, stale-device resurrection, and overlapping backup triggers.
- Never replace a missing HTTP ETag with unrelated Drive metadata.
- Map structured domain failures to diagnostics at the app boundary; do not infer success from an old timestamp.
- Monitor snapshot growth and Drive read cost before introducing compaction. Any future compaction needs a conflict-safe protocol of its own.

## Related Issues

- [Drive JSON media reads lose the concurrency ETag](drive-json-media-read-loses-etag.md)
- [Cross-device WorkLog sync duplicates](../database-issues/cross-device-worklog-sync-duplicates.md)
- [Drive readiness must stay separate from Google OAuth health](drive-readiness-diagnostic-states-2026-07-05.md)
