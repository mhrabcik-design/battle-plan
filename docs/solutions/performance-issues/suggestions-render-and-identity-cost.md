---
title: "Avoid repeated identity lookups when importing suggestion replies"
date: 2026-09-19
module: Hermes Suggestions
problem_type: performance_issue
component: drive-sync
severity: medium
symptoms:
  - "Suggestions refresh still spends time processing an unchanged reply history."
root_cause: redundant_sync_work
resolution_type: code_fix
tags: [suggestions, indexeddb, performance, identity]
---

# Avoid repeated identity lookups when importing suggestion replies

## Problem

Network snapshot caching does not remove the local cost of replaying proposal
history. `SuggestionRegistry.ingestLegacy` first ensured every proposal identity,
then repeated that database work for every reply to those same proposals.

## Symptoms

A synthetic workload of 100 proposals and 500 replies performed 600 identity
lookups on every ingest, including unchanged replays. Each lookup includes an
occurrence alias scan, making reply history expensive even without new data.

## Solution

The pending local fix keeps a map of verified subject/occurrence IDs inside the
existing transaction in `battle-plan/src/services/suggestionRegistry.ts`. The
proposal pass populates the map; replies reuse it. This workload now performs
100 identity lookups. The last occurrence of a duplicate proposal ID wins,
matching the previous proposal map's behavior.

## Why This Works

Ingest does not change occurrence aliases. A verified occurrence owner cannot
become ambiguous later in the same transaction. Only IDs are retained; mutable
subject rows are not cached. Unknown proposal IDs are still ignored, ambiguous
aliases still fail closed, and a failed write still rolls back the transaction.

The map must remain local to this transaction. Sharing it between refreshes
would skip changes to aliases and decisions arriving through other operations.

With Node 25.2.1 and fake IndexedDB, two warmups followed by five measured runs
gave these medians using the actual implementation and identical data:

| Operation | Before | After |
| --- | ---: | ---: |
| Initial import | 913.4 ms | 97.4 ms |
| Unchanged replay | 852.5 ms | 97.0 ms |

Complete registry snapshots had identical checksums before and after. These
are synthetic local timings, subject to host load, not Google Drive latency or
production browser timings.

## Prevention

`battle-plan/src/services/suggestionRegistry.test.ts` checks the lookup count
alongside alias precedence, duplicate proposal IDs, unknown replies, published
metadata/task IDs, invalid deferrals and transaction rollback. Preserve both
the workload bound and the decision outcomes when changing this path.

## Related

- [Network refresh costs](suggestions-repeat-sync-cost.md)
- [Durable suggestion decisions](../architecture-patterns/durable-suggestion-decision-registry.md)
