/**
 * What an attempt tells a joiner about the agent it was driving.
 *
 * One bit, because one bit is what every attempt can state honestly and what
 * every joiner actually needs. The three attempts this seam carries — a fresh
 * lead start, an attach, a reserved rehydrate — end in outcomes of three
 * different shapes, and none of them is meaningful to a joiner that ran none of
 * that work under none of those inputs. "Is there a connector for this agent
 * now" is meaningful to all of them.
 */
export type StartAttemptOutcome =
  /** A connector for this agent is live, as far as this attempt got. */
  | 'connected'
  /**
   * The attempt ended without building one, and said so rather than throwing.
   *
   * The modeled non-successes: a recovery that deferred or was refused, a start
   * that lost its designation race. They are *resolutions*, so a joiner watching
   * only for a rejection cannot see them.
   */
  | 'no-connector';

/**
 * One agent's start attempt, as a joinable handle.
 *
 * `settled` resolves — or rejects — when the attempt is completely over,
 * including every failure-cleanup step, and it carries **the attempt's own
 * verdict**. That is what a joiner reads.
 *
 * It did not always: joiners used to await the promise for its timing alone and
 * then re-read the agent row. The row cannot answer the question. Where an
 * attempt *writes* it the row is authoritative about the row — a fresh start's
 * pre-dispatch failure deletes it, so mapping the rejection onto "dead" would
 * contradict the deleted-row rule for one event — but the row was never a proxy
 * for "a connector exists", and every place that treated it as one was one
 * interleaving away from being wrong. A recovery that rolls its claim back to
 * the `idle` it found leaves a row that reads *usable* behind an attempt that
 * built nothing; an `idle` row whose connector died is exactly what the liveness
 * probe exists to catch.
 *
 * So the division is: the attempt's verdict says whether a connector exists, and
 * the row says what state the agent identity is in. A joiner needs both, and
 * infers neither from the other. Where there is no entry to join — another
 * process, or one that died — there is no verdict to read, and the status
 * compare-and-swap arbitrates instead.
 */
export interface InFlightStart {
  /** Settles when the attempt is over, carrying what it left behind. */
  readonly settled: Promise<StartAttemptOutcome>;
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
 * What a joiner consumes instead is the attempt's own verdict — see
 * {@link InFlightStart.settled} — together with the durable agent row, which
 * says what state the identity is in but never whether a connector exists.
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
  readonly settled: Promise<StartAttemptOutcome>;
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
 * @param attempt - The complete attempt, answering whether it left a connector
 *   behind, including its reservation, its
 *   persistence, its settlement and its failure cleanup. Nothing that can leave
 *   durable state behind may run outside it: a joiner runs none of it, and what
 *   sits outside would then run twice, once against the wrong inputs.
 * @returns This call's handle — the attempt it registered, or the one it joined.
 */
export function runExclusiveStart(agentId: string, attempt: () => Promise<StartAttemptOutcome>): ExclusiveStart {
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
      return await attempt();
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
