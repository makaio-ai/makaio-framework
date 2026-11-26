---
'@makaio/services-core': patch
---

Stop the Bun listener of the worker exchange test boot host without awaiting Bun's stop promise, so the host exits after shutdown on Bun versions that leave that promise pending after WebSocket upgrades.
