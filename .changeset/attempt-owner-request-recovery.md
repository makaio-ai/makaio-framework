---
"@makaio/subsystem-workflow-engine": major
"@makaio/framework": major
---

Add durable owner-request recovery to the execution attempt port. Repository
implementations must implement `ensureAttempt` and `readAttemptSettlement` as
required core operations, independently of optional provider-allocation recovery.

`ensureAttempt` atomically associates an owner-scoped request key with one Attempt.
An equivalent repeated instruction returns that Attempt without restoring old
authority, changing its bootstrap deadline or creating an in-process waiter.
Changing the instruction for the same key returns a conflict. Existing
`createAttempt` callers retain deliberate fresh creation and waiter behavior.

`readAttemptSettlement` returns a coherent owner-scoped snapshot that distinguishes
missing, unsettled, canonical outcome and settlement without an outcome. Canonical
text is preserved verbatim and decoded afresh. Historical reads are evidence, not
permission to mutate or converge a superseded owner state.

Both reference repositories and the callable public conformance suite cover these
obligations. New public types include `EnsureExecutionAttemptInput`,
`EnsureExecutionAttemptPersistenceInput`, `EnsureExecutionAttemptDecision`,
`ReadAttemptSettlementInput`, and `AttemptSettlementRead<TOutcome>`.
