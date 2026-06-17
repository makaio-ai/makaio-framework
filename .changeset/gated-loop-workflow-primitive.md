---
"@makaio/contracts": minor
"@makaio/subsystem-workflow-engine": minor
"@makaio/runtime-node": minor
"@makaio/framework": minor
---

Add gated `loop` workflow primitive: a convergence loop that repeats a body sequence until a deterministic gate handler returns `pass`, `loop`, or `escalate`, with runtime-enforced `maxRounds` protection. Escalation reuses existing gate suspend/resume infrastructure for human intervention. Includes authoring API (`defineWorkflow().loop()` and standalone `loop()` factory), walk/projection support, runtime executor with frame-per-round tracking, and worker loader pass-through for `runtimeLoopGates`.
