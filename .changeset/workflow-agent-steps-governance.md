---
"@makaio/contracts": minor
"@makaio/subsystem-workflow-engine": minor
"@makaio/services-core": patch
"@makaio/ai-adapters-core": patch
---

Add governed workflow agent steps with dynamic for-each fanout, generic execution scope, mutable DAG scheduler, and hardened cancellation.

- `@makaio/contracts`: workflow scope replaces `projectId` with a `WorkflowExecutionScope` discriminated union (`global | workspace | session | external`); `AgentWorkflowStep` gains `harnessId` and `contextMode` fields; execution step state is now a union of `ExecutableStepState | CompositeStepState`; `listExecutions` requires bounded pagination (`limit` + `cursor`); `SubagentConfig.workstreamId` removed (product-tier field).
- `@makaio/subsystem-workflow-engine`: runtime for-each expansion with persisted `ForEachExpansionSnapshot`; mutable DAG scheduler replaces static topological levels; cancellation terminates all non-terminal states; `rebuildSchedulerGraph()` provides the persisted graph rebuild primitive; workflow storage moved to central migration tier (`storage/migrations`).
- `@makaio/services-core`: subagent harness passthrough — `startAdapterForSubagent` forwards `harnessId` from spawn config; execution-target resolution uses `SessionStorageSubjects.get` instead of product-scoped subject extension; `workstreamId` removed from `SubagentConfig`.
- `@makaio/ai-adapters-core`: harness persistence and config factory passthrough — `persistAndEmitAgent` writes `harnessId` to the agent record; `ConfigFactoryInput` gains `harnessId`; `buildConfigInput()` maps it automatically for all concrete adapters.
