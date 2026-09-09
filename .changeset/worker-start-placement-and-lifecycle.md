---
"@makaio/runtime-node": major
"@makaio/framework": major
---

Report confirmed absence when the thin workflow provider fails to resolve its
launch configuration before allocation, while preserving cancellation reasons.
The provider's public return type is now `WorkerProvisionOutcome`; direct
callers must narrow `kind` to `allocated` before accessing its handle or reference.
