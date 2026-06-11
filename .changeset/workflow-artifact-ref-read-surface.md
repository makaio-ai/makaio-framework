---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/subsystem-workflow-engine": minor
---

Make the workflow start artifactRef readable for consumers.

- `@makaio/contracts`: `WorkflowExecution` read model gains an optional `artifactRef`; new `WorkflowArtifactRef` type export.
- `@makaio/contracts`: `execution.started` carries the optional `artifactRef`; `listExecutions` accepts an `artifactRef` filter (workflowId/scope/artifactRef — at least one required).
- `@makaio/subsystem-workflow-engine`: `workflow_executions` gains indexed `artifact_kind`/`artifact_id` columns (migration 0012); start and worker write paths persist the ref.
