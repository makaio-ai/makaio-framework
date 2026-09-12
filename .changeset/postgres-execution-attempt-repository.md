---
"@makaio/framework": minor
"@makaio/storage-pg": minor
---

Add a PostgreSQL `ExecutionAttemptRepository` factory with durable, owner-fenced
attempt, provider-operation, cancellation, and control-evidence persistence.
The workflow-engine public schema now includes the central dual-dialect
execution-attempt tables and correlated migrations. Hosts construct the adapter
with their explicit PostgreSQL database handle and outcome codec; no pool or
outcome policy is implicit.
