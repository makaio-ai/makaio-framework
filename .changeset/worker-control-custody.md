---
"@makaio/subsystem-workflow-engine": major
"@makaio/framework": major
---

Persist cancellation intent independently of an execution attempt's outcome.
Repository implementations must provide `requestCancellation` and
`readCancellation`: requesting cancellation closes the operation-start gate of
the owner's existing attempts atomically with recording their intent, without
claiming that execution has stopped. Repeated requests preserve the first
intent. Creating future attempts remains the execution owner's policy.

Workflow runners accept a local-only `withAttemptCreation` admission callback.
The WorkflowExecutor uses its existing lifecycle queue to serialize owner
eligibility and attempt creation against cancellation; dispatch and outcome
waiting remain outside the queue. Resume and failed-resume rollback use that
same owner boundary. Direct runner consumers remain responsible for their own
owner-admission policy; this does not introduce distributed owner locking.

Provider-operation claim sources now supply an explicit renewal policy. Live
controllers renew their custody and relinquish local control when their lease
expires or ownership cannot be maintained. Recovered controllers must adopt the
same control lifecycle and replay durable cancellation intent before treating
the allocation as controlled.
