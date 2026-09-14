---
"@makaio/framework": minor
---

Extract generic headless worker runner alongside workflow-specific wrapper

Add `runHeadlessWorker`: workload-agnostic lifecycle runner that accepts pre-built
`InstalledWorkloadAdapter[]` and routes through `runWorkloadInvocation`. Handles
bootstrap, bus connection, control endpoint, runtime registration, invocation, and
cleanup without workflow-specific result parsing.

`runHeadlessWorkflowWorker` now delegates to `runHeadlessWorker` via a bridge adapter
pattern — zero behavior change for existing callers.

New exports: `runHeadlessWorker`, `HeadlessWorkerDeps`, `HeadlessWorkerResult`.
