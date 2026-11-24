---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/runtime-node": major
---

Use one Code Step context in caller-local and checkout-backed execution. It exposes JSON run data, an invocation abort signal, and the typed `request` and `launchProcess` operations. Migrate handlers away from direct bus, state, artifact, progress, trigger, and host-property access. Code Steps that revise artifacts through requests no longer update the workflow's current artifact binding or emit the frame-specific artifact update event. The WorkLog projection no longer subscribes to `workflow.artifact.updated` or writes artifact-write rows from it.

Managed processes use the verified materialized workspace root when available. The public worker configuration accepts an optional `stepTimeoutMs` for caller-local managed processes. On the standard local worker connection, file handlers can still request subjects known only to the host. These requests receive JSON responses without subject-schema validation in the thread.
