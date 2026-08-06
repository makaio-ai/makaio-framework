/**
 * Timing budgets a connector may spend *observing* the end of a resource it is
 * tearing down.
 *
 * These are deliberately not general-purpose timeouts. A teardown reports what
 * it observed, and observing an end takes a bounded amount of wall-clock time;
 * the budget below is the boundary between "we watched it end" and "we stopped
 * watching and can no longer claim it ended".
 * @packageDocumentation
 */

/**
 * Milliseconds a connector may wait for a resource it just terminated to be
 * observed as terminated.
 *
 * Chosen to match the archive and cancel budgets connectors already apply to
 * provider round-trips, and deliberately far below the adapter-instance close
 * budget so a single instance close can still contain several agent teardowns.
 *
 * The same budget bounds the confirmation a backend has to acquire for itself
 * when its termination call reports success but publishes no end event: "did
 * the resource end" is one question whether it is asked of a process, a
 * connection, or a superseded generation of either.
 */
export const CONNECTOR_EXIT_OBSERVATION_MS = 2_000;

/**
 * Milliseconds a teardown may wait for a connector replacement it found in
 * flight to settle.
 *
 * **A liveness ceiling, not a correctness boundary.** It exists so a stop is
 * never *unbounded*, not so it can only fire on a broken replacement: the waited
 * region contains awaits no adapter budget covers — config resolution, auth
 * preparation, connector construction, event wiring, account prepare and commit,
 * the awaited movement announcement, the previous runtime's lease release — so a
 * replacement that respects every budget it declares can still lose this race.
 * **Its expiry may hit a perfectly legal replacement, and that is a specified
 * normal path rather than an anomaly**, which is safe only because expiry hands
 * both runtimes back to the replacement instead of closing anything.
 *
 * The value is therefore a user-visible-latency decision: every consumer of a
 * teardown waits for it synchronously, including a session close that holds
 * until its slowest agent teardown finishes and has no request deadline of its
 * own to clamp against. Ten seconds is the order at which an interface must show
 * progress rather than appear hung, and it is deliberately **shorter** than a
 * legal slow replacement's worst case.
 *
 * It is **not** ordered against the deadline of whoever is waiting on the
 * teardown. The two are related per request by a clamp — the effective wait is
 * the smaller of this ceiling and what remains of that deadline less one
 * {@link CONNECTOR_EXIT_OBSERVATION_MS} of margin — and the margin is that
 * constant rather than a new one because the expiry arm closes nothing: all that
 * remains after it is a status write and the reply.
 *
 * Against the other two budgets the ordering runs from smallest to largest:
 * {@link CONNECTOR_EXIT_OBSERVATION_MS} (one observation), then
 * `ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS` (an instance close containing several
 * observations), then this (one user-visible stop). That last step is an
 * intentional inversion: an instance shutdown overlapping a replacement times out
 * and reports `unknown`, and inside that window the replacement owns both
 * runtimes.
 */
export const SWAP_SETTLEMENT_WAIT_MS = 10_000;
