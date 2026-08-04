/**
 * One agent's start attempt, as a joinable handle.
 *
 * `settled` resolves — or rejects — when the attempt is completely over,
 * including every failure-cleanup step. A joiner awaits it and then **re-reads
 * the agent row**: where the attempt writes that row, the row is what says what
 * happened, never the promise's outcome. A fresh start's pre-dispatch failure
 * both deletes the row and rejects the attempt, so a rule that mapped rejection
 * onto "dead" would contradict the deleted-row rule for the very same event.
 *
 * The rejection is not noise, though, and a joiner may not discard it blindly:
 * an attempt whose failure path writes no status — a rehydrate, whose agent row
 * belongs to the adapter — leaves the row exactly as it found it, and a joiner
 * reading it would take the row's *pre-attempt* state for the attempt's result.
 * Such a joiner reports the rejection it can see. What no joiner may do is infer
 * a row state from a rejection, or ignore a row an attempt did write.
 */
export interface InFlightStart {
  /** Settles when the attempt is over; carries no verdict of its own. */
  readonly settled: Promise<void>;
}

/**
 * One call's view of {@link runExclusiveStart}.
 *
 * The flag is what makes the seam usable by a caller that has durable work of
 * its own to do around the dispatch. A joiner ran none of that work — the
 * attempt it joined did, under *its* inputs — so a joiner that went on to
 * persist its own adapter identity, or to settle the provider session *it*
 * planned to resume, would overwrite the identity the running attempt actually
 * established.
 *
 * What a joiner consumes instead is the attempt's authoritative result: the
 * durable agent row, re-read after {@link InFlightStart.settled}. The row is
 * shared, survives the process, and is what every other consumer rule in this
 * wave already treats as the verdict — the promise carries none.
 */
export interface ExclusiveStart extends InFlightStart {
  /**
   * `true` when this call joined an attempt that was already running, and
   * therefore ran no callback of its own.
   */
  readonly joined: boolean;
}

/** Internal view of a published entry. */
interface MutableInFlightStart {
  readonly settled: Promise<void>;
}

/**
 * Attempts in progress in **this process**, keyed by agent.
 *
 * Deliberately process-local and un-persisted. It makes the same-process case
 * exact — a concurrent consumer joins instead of racing — while the durable
 * arbiter for a start whose owner is another process (or a dead one) is the
 * status compare-and-swap on the agent row. A persisted registry would need its
 * own liveness story and would answer the wrong question anyway: what a joiner
 * needs to know is whether *this* runtime is already driving the attempt.
 */
const inFlightStarts = new Map<string, MutableInFlightStart>();

/**
 * Register a start attempt for an agent and run it, so a concurrent consumer
 * joins the attempt instead of racing it.
 *
 * The entry is published **before** `attempt` runs, and therefore before the
 * attempt's first durable write. That ordering is the whole point: there is no
 * instant at which a `starting` agent row is visible without its entry, so a
 * joiner never has to guess whether an attempt is in progress here.
 *
 * Re-entering for an agent that already has an entry returns the existing one
 * and does **not** run `attempt` — two lifecycle attempts for one agent
 * identity are exactly what this seam exists to prevent. The returned handle
 * says which of the two happened, because a caller whose `attempt` carries
 * durable work must not repeat that work against inputs the running attempt
 * never used (see {@link ExclusiveStart.joined}).
 * @param agentId - Agent identity the attempt belongs to; the seam's key.
 * @param attempt - The complete attempt, including its reservation, its
 *   persistence, its settlement and its failure cleanup. Nothing that can leave
 *   durable state behind may run outside it: a joiner runs none of it, and what
 *   sits outside would then run twice, once against the wrong inputs.
 * @returns This call's handle — the attempt it registered, or the one it joined.
 */
export function runExclusiveStart(agentId: string, attempt: () => Promise<void>): ExclusiveStart {
  const existing = inFlightStarts.get(agentId);
  if (existing !== undefined) return { joined: true, settled: existing.settled };

  // The attempt waits on a gate that is opened only after the entry is in the
  // map, so the entry is published before the attempt's first statement without
  // the map ever holding a stand-in promise. A stand-in would be observable: a
  // joiner arriving during the attempt's synchronous prefix would await an
  // already-resolved promise and conclude the attempt was over before it had
  // begun.
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  // Declared before the attempt so the cleanup can compare against it, assigned
  // before the gate opens so it is never read unset — the gate is what orders
  // the two.
  let entry: MutableInFlightStart | undefined;
  const settled = (async () => {
    await gate;
    try {
      await attempt();
    } finally {
      // Identity-checked: a later attempt for the same agent owns its own
      // entry, and this one must never evict it.
      if (inFlightStarts.get(agentId) === entry) inFlightStarts.delete(agentId);
    }
  })();
  entry = { settled };
  inFlightStarts.set(agentId, entry);
  openGate();
  return { joined: false, settled };
}

/**
 * Look up an in-flight start without creating one.
 *
 * A consumer that finds an entry joins it. Finding none means the attempt
 * belongs to a process that is gone, or to a live peer — neither of which this
 * registry can see, so the caller arbitrates through the agent row's status
 * compare-and-swap instead.
 * @param agentId - Agent identity to look up.
 * @returns The entry, or `undefined` when this process is not driving a start.
 */
export function peekInFlightStart(agentId: string): InFlightStart | undefined {
  return inFlightStarts.get(agentId);
}
