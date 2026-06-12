---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/subsystem-workflow-engine": minor
---

listGateInstances accepts status-filtered, bounded queries without executionId — enables a cross-execution gate inbox.

- `@makaio/contracts`: new `GateInstanceListQuerySchema` (`executionId` and/or `status`, at least one required, bounded `limit` defaulting to 50); extracted `WorkflowGateStatusSchema` + `WorkflowGateStatus` type.
- `@makaio/subsystem-workflow-engine`: storage `listGateInstances` enforces the filter and limit bounds in code, orders by `createdAt desc, id desc`; the public delegation forwards the full query.
