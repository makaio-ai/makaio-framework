---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/runtime-node": major
---

Use one step runner contract for code and agent steps. `WorkflowRunnerStepTypeSchema` now accepts `agent-step` alongside `code-step`. Step invocations carry data and a working directory. The worker owns workflow transport and lifecycle.

Run checkout Code Steps, registered Code Steps in the local Piscina worker, and structured Agent Steps in worker-owned child processes. Local file starts and direct replays of those starts keep the caller-local runner. The explicit `in-process` mode continues to execute workflows on the host thread.

Define a loop check by the ID of a step that completes once per round with `{ done: boolean }`. Both runners execute it as part of the loop body and honor the loop's exhaustion policy. This replaces the loop-check handler, registration and outcome exports with `LoopCheckOutput` and its schema. Stored loop definitions and in-flight snapshots that reference standalone check handlers fail definition validation and must be updated before they can be read by this runtime.

`StepRunResult.status` now includes `cancelled`. `StepRunResult.error` now accepts a fixed set of machine-readable codes defined by the new `StepRunErrorCode` and `StepRunErrorCodeSchema` exports. Caller-local diagnostics use the optional `detail` field. Remote workers no longer receive permission to publish `workflow.execution.progress` or `workflow.artifact.updated`. The historical event definitions remain available to consumers of the published contracts.

When a runner provides failure detail, the failed step frame stores it in the existing human-readable `error` field. The workflow result and frame failure event retain the machine-readable code.

The workflow-engine orchestrator now requires an `IStepRunner`. Hosts running local handlers use `runCallerLocalWorkflowOrchestrator`. Process hosts use the runtime's exported `runProcessWorkflow` and its process admission policy. Both runners apply node-owned Agent Step policy through the workflow orchestrator's exported `resolveAgentStepConfig`. The runtime also exports `ProcessStepRunnerOptions`. Checkout request-refusal callbacks (`onRequestRefused`) may return `void` or `Promise<void>`. `IStepRunner` no longer declares `managesWorkflowLifecycle`.

With the standard connector, `runWorkflowInWorker` reports `sourceNotPrepared` for Code Steps. To run Code Steps in an admitted Piscina attempt, supply the prepared source for an authority-owned attempt through the admitted entry with the host's admission connector. Path-backed attempts require a local materialization specification and a matching verified workspace. Inline attempts use the admitted source text. The admitted entry runs these Code Steps in dedicated processes.

`IWorkflowRunner.requiresDefinitionSnapshot` lets the runner request the resolved registered definition alongside the executable source. The Node runtime exposes `createPiscinaWorker` to build a worker entry with host composition, `ConnectedWorker.stepModel` to supply worker-local model authority, and `callerLocalFileRunner` for file starts and direct replays.

The default export of `./workflow-worker/worker-entry` is assembled by `createPiscinaWorker` with the standard connector. It accepts both `unbound` and `caller-local-file` task kinds. Custom pool entries can use the factory with their own connector.

`WorkflowErrorCode` adds `DEFINITION_NOT_FOUND`, `AGENT_STEP_UNSUPPORTED`, `LOOP_CHECK_MULTIPLE`, and `STEP_OUTPUT_SCHEMA_INVALID`.
