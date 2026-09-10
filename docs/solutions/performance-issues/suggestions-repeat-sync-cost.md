---
title: Avoid repeated downloads and writes during Suggestions refresh
date: 2026-09-09
module: Hermes Suggestions
problem_type: performance_issue
component: drive-sync
severity: medium
symptoms:
  - "Changes in Suggestions appear slowly."
  - "Refresh repeatedly downloads and merges old decision snapshots."
root_cause: redundant_sync_work
resolution_type: code_fix
---

# Suggestions refresh costs

## Problem and cause

The page polls every 30 seconds and the badge every 60 seconds. Their reads
could overlap without sharing work. The registry's create-only protocol
retains complete historical snapshots, so each refresh downloaded every
snapshot and rewrote unchanged rows in IndexedDB. Date/priority edits also
waited for their audit reply before reflecting the successful primary write.

## Fix (pending merge)

- Coalesce overlapping reads in the Suggestions services; release the promise
  when it settles so subsequent refreshes remain fresh.
- Opt the registry store into an in-memory content cache. Always list current
  Drive files and their versions; download new/changed versions and evict
  removed files. Missing versions bypass the cache. Return cloned values.
- Continue validating and merging every snapshot, but skip identical database
  writes. Conflicting immutable decisions still fail closed.
- Display the validated page snapshot before publication finishes, and display
  a saved date/priority before its audit reply finishes.

The cache is not enabled for mutable read-modify-write flows, especially
replies. It does not supply a substitute for ETags. Drive's version field is
used only to detect changes for reads, never as a write precondition:
[Drive file metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).

## Verification

Regression tests observed 40 downloads for two reads of 20 unchanged files
before the fix, versus 20 afterward (zero additional content downloads on the
second read). They cover changed/new files, missing versions, caller mutation,
uncached reads, removal, concurrent reads, and case-sensitive duplicate order.

A local Node/fake-indexeddb experiment replayed one snapshot containing 60
decisions after an initial merge. Across five repetitions, median merge time
was 24.9 ms before versus 6.5 ms after skipping unchanged writes. This is a
synthetic database measurement, not authenticated Drive or page latency.

## Prevention and limits

Preserve the original lexical ordering of Drive IDs: other consumers select
the first duplicate. Do not compact/delete historical snapshots to improve
speed without a separate convergence design. Cache lasts only for the current
service instance; first load still reads all snapshots, and history is still
validated and merged on refresh. This change reduces repeated work without
changing polling intervals or promising instant cross-device delivery.
