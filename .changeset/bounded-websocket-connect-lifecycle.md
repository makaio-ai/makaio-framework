---
'@makaio/framework': major
'@makaio/bus-transport-websocket': major
---

Bound the complete WebSocket connection attempt and expose typed connection
failures through `WebSocketConnectionError` and its error-code union.

Breaking behavior change: `connectTimeoutMs` now covers socket factory execution,
socket opening, authentication and subscription replay together. Previously it
only bounded socket opening after the factory returned. Configure the budget
for the whole connection attempt; peer subscription-sync readiness remains a
separate bus handshake.

Disconnect and timeout discard late factory sockets and fence stale connection
continuations. HMAC cleanup settles pending authentication waits instead of
leaving them unresolved. Explicit authentication refusal, policy close,
connection loss and handshake or connection timeout have distinct error codes;
unknown custom factory, authentication and codec errors remain unchanged.

Server connection setup uses policy-close code `1008` only for explicitly typed
authentication or policy rejection. Timeouts and unknown setup failures close
with `1011` instead of being presented as credential rejection. Custom auth
strategies should throw a typed rejection when they intend a policy refusal.

Direct E2E authentication also fences invalidated crypto and key-lookup
continuations so they cannot overwrite a replacement session. Its client
handshake waits are now installed before initial ephemeral-key generation,
including that phase in their timeout. Session keys become available only
after successful authentication; interrupted waits settle during cleanup.

Built-in E2E handshake timeouts and credential refusals use the same typed
categories as HMAC. Malformed HMAC signatures are credential refusals, not
internal setup failures. Only genuine refusals send a negative authentication
result; unknown crypto or lookup errors retain their original identity.

Malformed E2E exchange fields and invalid peer key encodings are authentication
refusals. Unsupported authentication protocols are explicit policy refusals.
These peer-input failures remain distinct from internal cryptographic or
credential-store failures.

Connection cancellation also settles if custom cleanup or socket close throws.
Such teardown failures produce an `AggregateError` retaining the original
connection failure as its cause and the individual cleanup failures, rather
than masking either failure or leaving the connection pending.

Failed socket acquisition settles only that attempt's readiness promise, without
marking a replacement connection ready. A failed positive HMAC verdict send
rejects authentication before server admission; negative verdict delivery remains
best-effort so it cannot hide the original refusal.
