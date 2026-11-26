---
'@makaio/framework': major
'@makaio/contracts': major
'@makaio/runtime-node': major
'@makaio/runtime-bun': major
'@makaio/services-core': major
'@makaio/bus-transport-websocket': minor
---

Add an opt-in WebSocket exchange for worker bootstrap credentials. Admit a run session after the owner and dispatch commit together, and apply the same UTF-8 budget to the stored result and the public reply.

**Breaking:** An atomic redemption owner supplies `preparePayload(latestResultAt)` on its locked order in place of a precomputed `payload`. The callback builds the final JSON reply from the locked booking and the session deadline. The owner persists the supplied result without rewriting it.

The public host database transaction accepts a caller abort signal. An abort skips queued work or rolls back active work before commit. A commit already handed to the database can still persist. The WebSocket transport exports `ConnectionExchangeConfigurationError` and `verifyConnectionExchangeIngress`. The Bun runtime exports the `BunExchangeUpgradeData` type.

Binding a worker exchange requires a host abort signal. An invalid signal fails at binding with `WS_INVALID_EXCHANGE_HOST_SIGNAL`. Transport shutdown cancels pending exchanges before closing sockets, and admission rechecks the absolute deadline after the transaction completes.

Redemption checks the effective setup deadline after acquiring the order lock and again before returning acceptance to the transaction, rolling back if the deadline elapses.
