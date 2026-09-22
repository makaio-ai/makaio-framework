---
'@makaio/bus-core': minor
'@makaio/framework': minor
---

Add message-selective outbound eligibility to the bus transport contract (#1372).

`BusTransport` gains an optional `canSend?(message: BusMessage): boolean` method next to
`isReady`. When present, the bus uses `canSend` in preference to `isReady` on outbound
event paths to determine whether a specific message can be routed through a transport.
This allows relay codecs to pass control-plane frames in plaintext before an E2E session
is established while vetoing application-level messages.

`getReadyTransports` accepts an optional `message` parameter. When provided and the
transport implements `canSend`, the per-message predicate applies; otherwise the
message-agnostic `isReady` check is used. The `normalizeTransportTargets` helper threads
the outbound event message through `getReadyTransports` so the emit path benefits from
per-message eligibility. The relay path in `TransportRegistry` (`getRelayTargets`) is
likewise message-aware.
