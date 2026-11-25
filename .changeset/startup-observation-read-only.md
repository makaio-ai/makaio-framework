---
"@makaio/bus-core": major
"@makaio/bus-transport-websocket": major
"@makaio/framework": major
"@makaio/kernel": major
---

Keep startup-observable namespaces read-only at the WebSocket boundary.
The host rejects an external request-handler wildcard in full if it matches any subject in a startup-observable namespace.
Require an admitted subscription pattern for WebSocket subject fan-out when the host enforces boundary access checks; events addressed to one connection (`emit` with `connectionId`) still pass only the per-message delivery check.
Restore admitted and deferred subscriptions after a failed update, and acknowledge the failure with one typed error when admission or registry staging throws during an acknowledged update.
Give payload-aware rights sources a frozen copy while keeping the original payload writable for handlers.
Give each rights source its own deeply frozen question context.
Reject pending external operations with `host-not-ready` when the host closes admission during authorization.

**Breaking changes**

- The public `BoundaryAccessTarget` type requires `messageType` on subject operations, so custom transports must supply it to pass type checking.
- Registering the same host namespace again with a different `startupObservable` declaration now throws an error.
- WebSocket denial responses can now carry the reasons `startup-observable-read-only`, `subscription-dispatch-failed`, and `subscription-not-admitted`.
- With boundary access checks enabled, a connected WebSocket client without subscriptions goes from receiving every fanned-out event that passes the per-message delivery check to receiving only events addressed to its connection until it subscribes to an admitted pattern, while hosts configured with `NO_BOUNDARY_ACCESS_CHECK` continue to deliver events to unsubscribed clients.
- Rights sources receive a deeply frozen copy of the question context; a source that mutates it in place now throws and resolves as `source-unavailable`.
