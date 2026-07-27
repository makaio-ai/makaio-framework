---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/extension-git-hooks": patch
"@makaio/extension-workflow": patch
---

Add provider-neutral, recoverable worker execution contracts and lifecycle handling.

- Introduce serializable allocation references, execution-scoped bootstrap claims, runtime materialization, and recoverable WorkerNode provisioning contracts.
- Add headless worker startup, cancellation, outcome finalization, and authority recovery support.
- Route workflow and git-hook execution through the unified worker execution lifecycle.
