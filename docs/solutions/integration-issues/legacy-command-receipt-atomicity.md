---
title: Legacy command replay after a failed Drive acknowledgement
date: 2026-09-25
category: integration-issues
tags: [dexie, agent-bridge, idempotency, transactions]
---

# Legacy command replay after a failed Drive acknowledgement

The legacy bridge previously mutated the domain before recording completion. Its
in-memory processed-ID cache was updated only after Drive acknowledgement. A
failed acknowledgement or a crash therefore allowed a create command to run again.

`AgentBridge.applyWrite` now commits the domain mutation and the durable
`agentInbox.execution_result` in one Dexie transaction, including task events,
outbox effects and WorkLog deletion tombstones. Replays return the saved outcome;
the same ID with different command content is rejected. Google delivery starts
after the transaction commits. Pending remote acknowledgements remain fetchable.

A nested Dexie transaction that throws aborts its parent even if the error is
caught. Expected WorkLog validation failures consequently store their terminal
receipt in a new transaction after rollback, rechecking for a concurrent receipt.
Unexpected persistence failures remain retryable and do not commit mutations.

Clearing diagnostics hides completed rows instead of deleting execution evidence.
Historical applied rows remain replay guards. This provides atomicity within one
local database, including multiple tabs; it is not cross-device exactly-once
execution. The signed v2 command runtime remains disabled.

Regression coverage includes failed Drive acknowledgements, database reopening,
concurrent replay, conflicting payloads, receipt-write failure, task/event/effect
rollback and diagnostic clearing.
