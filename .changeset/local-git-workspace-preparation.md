---
"@makaio/runtime-node": minor
"@makaio/framework": minor
---

Add an injectable local Git source strategy for created Workspaces. Source
acquisition selects the requested revision before the existing setup and
workload invocation sequence, while preserving caller-controlled release.
Forward workload cancellation into the local preparation callback so source
acquisition can stop through the existing bounded command runner.
