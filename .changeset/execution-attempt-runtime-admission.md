---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/subsystem-workflow-engine": major
"@makaio/runtime-node": major
---

Move runtime registration and operation admission onto the ExecutionAttempt as one coordinated breaking cut. The attempt owns the runtime endpoint and the start gate; the worker namespace only projects what the attempt decided. No aliases, dual registrations, or compatibility re-exports are provided.

Breaking:

- `worker.control.attempt-ready` is removed from the `worker` namespace (12 subjects → 11). It is replaced by `execution-attempt.runtime.register` (RPC) and `execution-attempt.runtime.ready` (event), which are bound to the attempt, its allocation, its fence, and its runtime generation, and are durably accepted before readiness is published.
- `worker.lifecycle.ready` loses `adapters`; it now projects accepted runtime readiness from `execution-attempt.runtime.ready`, and `worker.lifecycle.busy` projects `execution-attempt.operation.admitted`. Adapter composition is a workflow-runtime concern and is no longer part of the readiness surface.
- `ExecutionAttemptRepository<TOutcome>` gains five required members — `registerRuntime`, `admitOperation`, `completeOperation`, `markRuntimeReady`, and `getAttemptControlState` — and ten new record fields; `createAttempt` and every terminal settlement additionally close the operation start gate. Every realization must be updated.
- The attempt transport allowlist drops `worker.control.attempt-ready` and gains three static subjects: `execution-attempt.runtime.register`, `execution-attempt.operation.admit`, and `execution-attempt.operation.deliver`. `buildExecutionAttemptAllowedSubjects` keeps its `(executionId: string)` signature.
- `WorkflowWorkerReadyMessage` loses `adapters` and gains `executionAttemptId`; the Piscina provider no longer publishes readiness on the worker's behalf and now requires a bus URL.
