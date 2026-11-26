---
'@makaio/framework': minor
'@makaio/runtime-node': minor
'@makaio/runtime-bun': minor
'@makaio/bus-transport-websocket': major
---

Add `singleHostWorkerExchange` to Node and Bun host boot. It defaults off and opens an exchange-only listener with either native TLS or a verified TLS-terminating ingress. It is intended for deployments with one host per database. Two enabled hosts could both route the same run.

Bun enforces the configured exchange message limit in its native listener and reports invalid TLS credentials as `invalid-tls`, matching Node. Scoped retirement also cancels verified exchanges before session publication.

For custom host composition, `ServerTransportConnectOptions.workerExchange.boundHost` is optional, and Node's `waitForServerListening` accepts an optional post-bind error observer. Bun's `createBunRouteGraphFetch` accepts an undefined route graph for an exchange-only listener. Its ingress verifier receives the immediate peer address when available through `BunRouteGraphUpgradeServer.peerAddress`.

**Breaking:** Transport setup handlers that call `markVerifiedRevocationKey` must now supply the verified caller and revocation key together. `ConnectionExchangeAuth.bindExchangeRetirement` now requires a `forceDetach` callback. Its graceful retirement callback receives the native `terminate` function first, then the optional close code and final response origin.

For protected worker sessions, the transport verifies and hands off incoming messages in arrival order. Handlers can finish independently of later messages. A failed owner check retires the session and discards queued messages. Subscription updates share this order. If a subscription publication fails after handoff, the transport retires the session and removes its routes so a late failure cannot overwrite newer routing state.
