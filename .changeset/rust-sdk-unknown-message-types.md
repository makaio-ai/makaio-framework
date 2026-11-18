---
"@makaio/framework": major
---

The Rust SDK (`makaio-sdk`) skips inbound wire frames whose `type` it does not know instead of closing the
connection (FACT-455).

Wire protocol extensions are additive, so a client must ignore frame types it does not model. Before this change,
one unknown frame (for example `subscription-ack`) failed to decode like broken JSON, ended the client read loop,
and failed every pending request with `CONNECTION_CLOSED`, on both the WebSocket and the stdio transport. Such a
frame now decodes as `BusMessage::Unknown`, which the read loop skips. Broken JSON, frames without a string
`type`, and malformed frames of a known type still fail as before, and the HMAC auth handshake still accepts only
`auth-challenge` and `auth-result`.

**Breaking: `BusMessage` gains an `Unknown` variant and is `#[non_exhaustive]`**

Code outside the crate that matches on `BusMessage` needs a wildcard arm. `BusMessage::Unknown` is receive-only:
it cannot be serialized, so it is never sent. Marking the enum `#[non_exhaustive]` means that modelling further
wire types later no longer breaks downstream matches.
