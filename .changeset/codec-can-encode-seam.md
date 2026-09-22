---
'@makaio/bus-transport-websocket': minor
---

Add message-selective codec encoding gate to fix relay boot noise without blocking
control-plane traffic (#1372).

`ClientTransportCodec` gains an optional `canEncode?(message: BusMessage): boolean`
member. When absent the codec is treated as able to encode any message. When it returns
`false` for a specific message, that message is vetoed for that transport — but other
messages (e.g. relay-control frames) that return `true` are still forwarded.

`WebSocketClientTransport.isReady()` reflects wire-session state only (socket open +
auth complete). A new `canSend(message: BusMessage): boolean` method combines the
wire-session check with `codec.canEncode?.(message)` for per-message routing decisions.

`createE2ERelayCodec` / the internal relay codec implement `canEncode` with
message-selective logic: relay-control bus messages, tracked relay-control response
correlation IDs, and subscription-control frames return `true` regardless of session
state; all other messages require an established session key (`e2eAuth.getSessionKey()`
non-null). This allows control-plane events (e.g. `relay.connection.stateChanged`) to
flow as plaintext envelopes and reach the paired browser before the E2E session is
established.

`createE2ERelayClientTransport` forwards `canSend` from the inner transport (bind) while
`isReady` continues to reflect wire-session state.

**Behavioural note for relay consumers:** before the E2E session is established,
relay-control events still flow as plaintext envelopes and reach the paired browser.
Normal application-level events are excluded by the `canSend` gate and are silently not
delivered to the relay leg. Request paths do not consult `canSend`; the relay leg is
still attempted, the codec's `encode` step throws, the transport error is logged, and
dispatch continues to the next entry — yielding `NoHandlerError` only when no local
handler or other transport covers the subject. Consumers that need to act when the relay
leg can carry arbitrary messages must key off their own session-established signal rather
than `BusLifecycle.connected`, which fires at wire-session establishment and does not
indicate that the E2E codec can yet encode arbitrary frames.
