---
'@makaio/framework': major
'@makaio/contracts': minor
'@makaio/subsystem-workflow-engine': major
---

Deliver accepted Attempt cancellation independently of operation admission and
persist runtime receipt separately from a final, explicitly scoped conclusion.

`ExecutionAttemptRepository` now requires `readAttemptCancellationControl`,
`recordAttemptControlReceipt`, and `reportAttemptControl`. Custom repositories
must implement atomic correlation and immutable replay per cancellation revision
and runtime generation. The shared conformance suite covers the required
semantics; the SQLite reference remains test-only support.

The static `execution-attempt.control.deliver` and `execution-attempt.control.report`
contracts separate delivery acknowledgement from `achieved`, `unsupported`, or
`unconfirmed` evidence. `reconcileAttemptCancellation` performs one explicit pass
with a bounded transport request; it creates no scheduler or provider policy.

Control evidence never rewrites canonical outcomes or their frozen control
observations, completes an operation, authorizes Workspace release, or settles a
Job. Runtime endpoints, driver integration and provider routing are separate
consumer work; this change does not switch existing cancellation paths.
