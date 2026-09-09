---
'@makaio/framework': major
'@makaio/contracts': major
'@makaio/subsystem-workflow-engine': major
---

Separate technical outcome acceptance from workflow lifecycle projection.

Attempt convergence must return an explicit `projected` or `recorded-only`
classification. Local outcome waiters now return `AcceptedAttemptOutcome`, which
retains the original canonical outcome and its frozen control observation.
Workflow runners preserve that envelope and can return an explicit
`authority-recorded-only` completion after the owner has durably cancelled.

Custom convergence implementations and direct waiter consumers must adopt these
required contracts. No outcome storage format or bus acknowledgement changes.
