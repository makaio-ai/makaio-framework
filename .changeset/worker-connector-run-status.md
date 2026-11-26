---
'@makaio/framework': minor
'@makaio/runtime-node': minor
---

Add an optional run-status reader to the ordered WorkerConnector connection. The worker checks owner-confirmed standing after subscription synchronization on initial admission and identity reconnect. The original expiry bounds reconnect, and cancellation subscriptions are replayed before each status check.
