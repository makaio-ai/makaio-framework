---
"@makaio/contracts": minor
"@makaio/subsystem-workflow-engine": minor
"@makaio/runtime-node": minor
"@makaio/framework": minor
---

Add the `loop` workflow primitive. A loop repeats a body sequence until its registered `check` returns `pass`. A check can return `loop` to start another round. When the final round returns `loop`, the workflow fails with a reason. Author loops with `defineWorkflow().loop()` or the standalone `loop()` factory.
