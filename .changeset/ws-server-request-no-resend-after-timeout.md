---
'@makaio/bus-transport-websocket': patch
'@makaio/bus-core': patch
---

Server-initiated requests are no longer re-sent to another client after a
timeout. A timeout leaves the outcome unknown, so a slow handler could
previously run a second time on the next interested client, contradicting the
`BusTransport.send` contract that the bus never re-sends a request. Routing now
moves on only when the send fails or the client answers that it has no handler;
a timeout surfaces as `TimeoutError` for the request subject and the caller's
budget instead of a final `NoHandlerError`.

All routing attempts share one deadline: each attempt is sent and tracked with
only the remaining budget, and nothing is sent once it is spent — candidate
lookup and serialization time included — so no client gets a fresh budget or receives the request after
the caller's timeout has elapsed. The wire `timeout` of each attempt is the
budget left after serialization — the same budget the attempt is tracked with —
and `0` for an unbounded request. A cancellation raised while the payload is
serialized (for example by a `toJSON` method) stops the attempt before it is
sent. The same holds for a cancellation raised while candidates are looked up
(subscription filters, authorization resolvers), including when it leaves no
candidate: the caller receives its own reason, not `NoHandlerError`. A request payload that cannot be serialized now fails with the
serialization error instead of being skipped per client and reported as
`NoHandlerError`.

`ServerTransport.cancelRequest` now reaches the in-flight attempt of a
server-initiated request and stops routing to further clients. The caller
receives its own cancellation reason unchanged, even when that reason is a
no-handler or timeout error, or when cancellation lands right after a client
answered that it has no handler.

Request budgets are validated where they enter the bus. `bus.request` and
`bus.broadcast` now reject a `timeout` that is negative, `NaN`, or infinite with
a `RangeError` before anything is dispatched — previously a negative or `NaN`
value rejected only after dispatch had started a remote hop that a transport
could then hold unbounded. An inbound request or broadcast carrying such a wire
`timeout` uses the default budget, as `readinessTimeout` already did, and the
WebSocket server keeps the response route of such a client request for that same
default budget instead of indefinitely. `resolveInboundRequestBudget` is exported
for transports that read a peer's wire budget themselves. `0` remains the only
"no timeout" value.
