---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/runtime-node": major
"@makaio/subsystem-workflow-engine": major
---

Move bound Piscina execution to host composition and use the workflow run
identifier for new attempts. A host that uses bound Piscina must configure
the provider with the bound worker entry. The runtime config accepts in-process execution and unbound Piscina.
Hosts select bound workers through the registered runner selector. The headless attempt harness, runtime clients
and workspace preparation move to host ownership. The Node runtime keeps the
generic worker connection and outcome delivery policy.

Worker dispatch, lifecycle, runtime input lookup, outcome reporting and
bootstrap claims use the run identifier. Provider requests and handles
expose the same run identity. Container bootstrap uses
`MAKAIO_EXECUTION_ID`.

The contracts package removes `ExecutionAttemptSubjects` and the associated
protocol schemas and types. The Node runtime removes bound Piscina, the
headless worker harness, and the attempt-specific bootstrap, delivery, and
workspace-preparation exports. The workflow engine removes
`ExecutionAttemptAuthority` and the attempt repository, provider operation,
and attempt testing entry points. Hosts own those surfaces and keep using the
workflow engine for run scheduling and lifecycle.

The workflow engine exports `WorkflowRunAdmissionErrorCode`. The
`run-not-admissible` code indicates that durable workflow state no longer
permits the host runner to admit new work.

Before upgrading a host that already provisions workflow workers, check for
open attempts carrying an older identifier.

```sql
SELECT execution_attempt_id, execution_id FROM execution_attempt WHERE execution_attempt_id <> execution_id AND settlement_kind IS NULL
```

Let those attempts finish or cancel them through the current host, then run the
query again. A run that already has an attempt retains it after upgrading,
including after settlement. Start a new workflow run when a new attempt is
needed. A replay of an existing owner request still returns its original attempt.
