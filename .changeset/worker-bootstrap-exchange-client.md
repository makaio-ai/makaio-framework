---
'@makaio/framework': minor
'@makaio/contracts': minor
'@makaio/runtime-node': minor
'@makaio/bus-transport-websocket': minor
---

Add opt-in ordered worker bootstrap over a verified TLS WebSocket. The published workflow contract requires a host-supplied `replayDeadlineAt` in the new `orderedBusAuth` configuration. Existing HMAC and unauthenticated launch inputs retain their shape.

The worker generates a runtime secret in memory. It uses the bootstrap deadline until a presentation can have reached the host, then uses the host's replay deadline and the existing client backoff to recover a committed reply. The host stays authoritative for first use and replay. The stock entry stops before loading a workflow source while an order decoder is unavailable.

Enable this mode only in test compositions until run identity reconnect and session revocation are available.
