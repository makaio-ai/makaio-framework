---
'@makaio/bus-transport-websocket': minor
---

Let a WebSocket client transport declare what `ready` means for its peer via the
new `readiness` option.

`'peer-sync'` (the default, and the previous behavior) resolves `ready` when the
peer's `subscribe-sync-complete` frame arrives. Only a bus server sends that
frame, so a transport connected to a plain message relay stayed pending for the
whole connection and armed the bus dispatch readiness gate indefinitely.

`'session-established'` resolves `ready` once this side's session is up — socket
open, authentication complete, buffered subscriptions replayed — which is the
strongest promise such a connection can honestly make. Each reconnect re-arms
and re-resolves readiness for the new session. Inbound `subscribe-sync-complete`
handling is scoped to `'peer-sync'`, so a peer able to emit or forward that frame
cannot settle readiness ahead of the milestone the mode promises — the inbound
listener is installed before authentication and replay finish.
