---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/subsystem-workflow-engine": minor
---

Add external execution registration API for engine-bypass runs.

- `@makaio/contracts`: new `registerExternalExecution` and `completeExternalExecution` request/response subjects on the workflow namespace. `registerExternalExecution` creates a minimal `workflow_executions` row (no definition, coordinator session, run-context, or runtime state required) so that subsequent lifecycle events (`execution.started`, `frame.*`, `execution.completed/failed`) satisfy the foreign-key constraints on WorkLog projection tables. `completeExternalExecution` updates the execution to a terminal status with cross-field validation (`'failed'` requires `error`, `'cancelled'` requires `reason`, `'completed'` rejects both).
- `@makaio/subsystem-workflow-engine`: handler implementations registered in the workflow storage delegation layer; externally registered executions are identified by the `wfx-ext-` ID prefix, preventing `completeExternalExecution` from targeting engine-owned executions that must go through the engine finalizer.
