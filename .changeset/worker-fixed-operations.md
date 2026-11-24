---
"@makaio/framework": patch
"@makaio/runtime-node": patch
---

Add worker-local fixed operations around isolated workflow steps. Validate source declarations against the frozen definition and check operation outcomes before recording facts. Prepared extensions receive their follow-ups after step completion, failure, or cancellation, with follow-up errors reported alongside the workflow outcome.
