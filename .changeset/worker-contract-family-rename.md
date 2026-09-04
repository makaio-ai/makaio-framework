---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/subsystem-workflow-engine": major
"@makaio/runtime-node": major
---

Rename the `WorkerNode` contract family to `Worker` as one coordinated breaking cut (#1261). `Worker` is the attempt-bound provider allocation; `Worker Runtime` is the process inside it. No aliases or compatibility re-exports are provided.

Wire and config literals:

- Bus namespace `worker-node` → `worker`; all twelve subjects follow (`worker.dispatch`, `worker.lifecycle.{provisioning,booting,ready,busy,paused,completed,failed,terminated}`, `worker.control.{attempt-ready,bootstrap.claim,outcome.submit}`).
- Capability id `'worker-node'` → `'worker'` (`WORKER_NODE_CAPABILITY_ID` → `WORKER_CAPABILITY_ID`).
- Workflow runner config `workflowRunner.mode: 'worker-node'` → `'worker'`; deployments must update their configuration.

TypeScript surface: `WorkerNode*` types, schemas, and factories become `Worker*` (`WorkerNodeNamespace/Subjects/Schemas` → `WorkerNamespace/Subjects/Schemas`, `WorkerNodeRunner` → `WorkerRunner`, `createWorkerNodeDispatchRunner` → `createWorkerDispatchRunner`, `WorkerNodeDispatchRunnerOptions` → `WorkerDispatchRunnerOptions`); the runtime-composition helpers become `WorkerRuntimeBusHandle`, `WorkerRuntimeContributions*`, and `loadWorkerRuntimeContributions`. Subpath exports move to `@makaio/contracts/worker` and `@makaio/framework/contracts/worker`.
