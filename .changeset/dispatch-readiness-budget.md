---
'@makaio/bus-core': minor
'@makaio/framework': minor
---

Bound the dispatch readiness gate to its own budget, and reduce it to a single rule.

A request can arrive while a transport is still completing its `ready` handshake, so
the routes that transport will advertise are not yet in the remote registry. The gate
closes that startup race. It previously waited on the caller's **full request
timeout**, so a transport whose `ready` never settled stalled every non-local request
in the process for 60 seconds each — including subjects whose local handler is a plain
database read.

The gate is now one rule: if remote-eligible transports are pending when a dispatch
starts, wait once — bounded by `min(readinessTimeout, remaining deadline)` — before
building the merged list, then build once and dispatch once.

- `RequestOptions.readinessTimeout` (default `DEFAULT_READINESS_TIMEOUT_MS`, 1.5 s;
  `0` disables the cap; non-finite or negative rejected with `RangeError`) replaces the
  request timeout as the bound. It travels on the wire so an inbound hop gates on the
  originating caller's budget, and is re-validated on ingress.
- Budget expiry is not a failure: dispatch proceeds with whatever is advertised and
  emits one debug diagnostic naming the transports still pending.
- Deadline expiry is a failure: `TimeoutError`. The deadline is resolved once per
  dispatch, re-checked before every chain advancement so nothing runs after it, and
  anchored by a receiving hop from the relative `timeout` alone — the wire `deadline` is
  an instant on the sender's clock and is never compared against the receiver's.
- The steady-state path adds no await: the pending set is checked synchronously and is
  empty once transports have settled.

**Dispatch never redoes work** — no second pass, no replayed chain, no re-sent remote
hop. Redoing work is only safe for operations known to be idempotent, and the bus has
no such knowledge. One consequence is deliberate: a local handler does not pre-empt the
wait, because a pending peer may yet advertise a higher-priority handler and the
cross-transport priority contract says that handler runs first.

The transport registry gained the supporting shape: `getPendingReadyEntries(names?)`
returns `{ name, ready }` pairs, and it and `getPendingReady(names?)` take an optional
transport-name filter so a pinned caller waits only on the peers it named.
