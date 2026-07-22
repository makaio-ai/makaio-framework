# Makaio SDK Conformance Harness Artifacts

`sdks/conformance/` holds the shared, language-neutral protocol cases for the Python and
Rust SDKs, plus the overlap cases the TypeScript SDK exercises through its public `BusClient`
facade. It is documentation plus JSON data only. There is no runner here.

## Files

- `cases.json` lists the scenarios the SDKs should mirror.
- `fixtures/messages.json` contains canonical wire messages referenced by the cases.

## Case Shape

Each case uses two simple pieces:

- `wire` is the ordered transcript of bus frames for the scenario. Each entry has a `direction`
  and a `messageRef` into `fixtures/messages.json`. Some replay cases also mark a `phase`
  such as `initial` or `replay`.
- `assertions` describes the semantic outcome the SDK harness should verify after replaying the
  transcript.

## Scope

The cases cover the current Makaio bus protocol shapes and SDK behavioral contracts:

**Wire protocol shapes:**
- `event`, `request`, `response`
- `broadcast`, `broadcast-response`
- `heartbeat`
- `subscribe`, `unsubscribe`, `subscribe-sync-complete`, `subscription-ack`

**Local dispatch behavior:**
- `local-request-dispatch` — request resolved by a local handler without wire roundtrip
- `local-request-priority-chain` — two local handlers with `next()` middleware chaining
- `local-event-parallel-dispatch` — event delivered to all matching local handlers
- `local-wildcard-event-matching` — wildcard pattern matches against event subjects

**Authentication:**
- `auth-challenge-response` — HMAC-SHA256 challenge-response handshake sequence

The cases cover both wire-level protocol shapes and SDK-level behavioral contracts (local
dispatch, middleware chaining). They are meant to be consumed by SDK tests, not by the
framework runtime.

## Fixture Rules

- `subscribe.subjects` is always a `Record<string, number[]>`.
- `subscribe.deliveryClasses` is always a `Record<string, "relayable" | "first-hop-only">`
  with one explicit entry for every key in `subscribe.subjects`.
- When multiple local handlers advertise the same subject, `first-hop-only` wins so the aggregate
  subscription cannot weaken any handler's relay boundary.
- `subscribe` messages represent replace semantics for the current local subscription snapshot.
- `unsubscribe` messages remove the full remaining priority set for a subject when no handlers remain.
- `subscribe` and `unsubscribe` may carry an optional `ackId`; transports that support dynamic
  subscription acknowledgement reply with `subscription-ack` for the same `ackId`.
- Request messages include `timeout`, `deadline`, and optional `priority` when the scenario exercises
  request propagation.
- Timestamp-like numbers are fixture-relative millisecond values, not wall-clock epoch values.
- No-handler responses use the structured bus error shape with `message`, `code: 'NO_HANDLER'`, and
  `subject`.
- `heartbeat` and `subscribe-sync-complete` are transport-level frames. They do not carry payloads.

## Scenario Coverage

The case set includes:

- event delivery
- request/response correlation
- no-handler responses
- subscribe replace semantics
- wildcard subscriptions
- reconnect subscription replay
- heartbeat handling
- broadcast / broadcast-response ignore handling
- local request dispatch (local-first without wire roundtrip)
- local request priority chain (middleware `next()` chaining)
- local event parallel dispatch
- local wildcard event matching
- HMAC auth challenge-response handshake

## How To Use

SDK test suites should load `sdks/conformance/cases.json`, resolve the named messages from
`sdks/conformance/fixtures/messages.json`, and assert the observed wire transcript against the
scenario. TypeScript facade tests should use the same fixtures where the wire behavior overlaps
with the protocol SDKs.
When a scenario references a `messageRef`, the referenced fixture is the canonical wire payload.
