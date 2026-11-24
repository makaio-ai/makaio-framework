---
"@makaio/bus-core": major
"@makaio/bus-server": major
"@makaio/bus-transport-websocket": major
"@makaio/contracts": major
"@makaio/kernel": major
"@makaio/runtime-bun": major
"@makaio/runtime-node": major
"@makaio/test-utils": minor
---

**Breaking:**

- Self-constructed Node extension contexts must supply `rights`.
- WebSocket server configuration and startup require `checkBoundaryAccess`. Pass a boundary check or the explicit `NO_BOUNDARY_ACCESS_CHECK` waiver. Custom server transport providers now receive `{ machineId, checkBoundaryAccess }` as the second argument to `connect`.
- External sends to unregistered, local, or channel subjects, or to subjects whose namespace has no active owner, are forbidden. `deserializeTransportError` returns an `AccessDeniedError` for structured `forbidden` denials. Read the subject from `error.data.subject`.
- Advertising request handlers and receiving requests or broadcasts to handle require `makaio.subject.handle`. Event subscriptions and deliveries use `makaio.subject.subscribe`. A response is accepted only from the connection that received its request or broadcast.

Handlers can query rights for the received call through `ctx.rights.handlerContext(call).hasRight(right, context)`. Registered answer sources receive a data-only call record and can request the JSON wire payload for selected rights. The transport returns structured denials for requests and acknowledged subscriptions. The local diagnostic includes the call context and records discarded WebSocket replies even with debug disabled.

If a right has no registered answer source, it is granted by default. This includes `makaio.subject.handle`: any authenticated peer can advertise itself as a handler for a registered, externally routable request subject. Replies remain bound to the connection that received the request or broadcast regardless of this default.

Clients without subscriptions receive events that pass the normal delivery check and live identity restrictions. With a boundary check installed, broadcasts go only to peers that advertised handler priorities for a matching pattern and pass the delivery check. With `NO_BOUNDARY_ACCESS_CHECK`, broadcasts go to every matching subscriber.

Host-owned namespaces can opt into startup observation. They may contain events and explicitly declared read-only requests. The runtime uses this for `kernel:boot`, so clients can subscribe to `kernel:boot.complete` and query `kernel:boot.getState` once its handler is registered. The normal registration, visibility, ownership, and rights checks apply. During startup, other requests, broadcasts, and available acknowledged subscriptions receive an immediate typed `host-not-ready` denial. Events have no reply frame. Reconnect advertisements can be retained for recheck at readiness.

Subscriptions to unavailable patterns can be acknowledged as pending before or after startup. Pending patterns stay outside routing until admission is rechecked on namespace registration or owner activation. A later rights denial ends replay of that pattern and is reported through the local `makaio:access.denied` diagnostic. The wire acknowledgement is sent once. Unsubscribing cancels a pending pattern, and disconnecting releases all pending state for the socket. Each socket can retain 1024 pending patterns and queue 512 KiB of unprocessed subscription frames measured before enqueueing. Exceeding either limit closes the socket with a reason.

If final peer revalidation fails after applying a subscription, the server removes the applied routing and sends a typed rejection while the socket is still open. `once()` waits for subscription propagation to settle and reports a typed denial when every transport path failed and there is no explicitly local route. Inbound request deadlines include time spent in authorization.
