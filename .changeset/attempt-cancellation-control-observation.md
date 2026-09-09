---
"@makaio/framework": major
"@makaio/subsystem-workflow-engine": major
---

Persist first-wins cancellation receipts for individual execution attempts and freeze the accepted control state alongside each committed outcome. Cancellation closes operation admission atomically while preserving owner-wide cancellation fanout and provider cleanup replay. Outcomes remain opaque; their interpretation and owner convergence behavior are unchanged.

Breaking: custom `ExecutionAttemptRepository<TOutcome>` implementations must implement `requestAttemptCancellation`, return correlated cancellation receipts from `readCancellation`, and persist and return `controlObservation` with outcome commit decisions and settlement reads. Existing outcomes without a recorded observation return `null`; implementations must not reconstruct that historical observation from current cancellation state. The shared cancellation decision helpers and in-memory and SQLite reference repositories provide the updated behavior.
