---
"@makaio/core": minor
"@makaio/bus-core": patch
"@makaio/bus-transport-websocket": minor
"@makaio/bus-transport-message-channel": patch
---

Tighten principal attestation at the edges.

- `@makaio/core` exports `attestationForRole(role)`, the one lookup of the
  attesting connection role table. It reads own keys only: an unknown role, or a
  key inherited from `Object.prototype` such as `'toString'`, yields `undefined`
  (no attestation). The WebSocket client, the HMAC identity registration and the
  message-port transport use it.
- The receive path accepts a principal claim only when the connection's
  attestation direction is an own key of its table.
- Outgoing relay-control envelopes no longer carry `metadata`; incoming ones
  already dropped it. The kind and id of a principal never reach the relay server
  in plain text.
- An end-to-end encrypted connection never attests (security tightening). The
  WebSocket client sets no attestation when its peer receive context is
  `encrypted`, whatever `attestingRole` it was given, so a hand-built
  `new WebSocketClientTransport({ auth: e2eRelayAuth, codec, … })` cannot vouch
  for principals either. Type narrowing: `E2ETransportOptions` and
  `E2ERelayClientTransportOptions` no longer accept `attestingRole`, and
  `createE2ETransport` sets it to `undefined` after spreading the caller's
  options. A caller that passed the role there must drop it; it never took
  effect as intended.

The SDK conformance case `request-with-principal-metadata` now states the rule
the code enforces (the SDK accepts the claim over its attesting core uplink,
`receiverAttestation: "outbound"`), and a new case
`request-with-unattested-principal-metadata` covers a connection without
attestation (principal equals caller).
