/**
 * The one place a teardown and a connector replacement meet.
 *
 * Two acts can end a connector's life on one agent, and they are different acts:
 * a **teardown** destroys the agent, a **replacement** keeps it and supersedes a
 * runtime. Joining them in one flight was a category mistake — a replacement
 * legitimately produces two runtimes and two closes. So they are arbitrated
 * instead, by one rule with one direction:
 *
 * **Replacements refuse when they find a teardown; teardowns wait when they find
 * a replacement.**
 *
 * No act ever waits on the act that waits on it, so a same-agent cycle is
 * unrepresentable rather than merely avoided, and per-agent keys keep cross-agent
 * cycles out. A second replacement queued behind an agent's mutation barrier
 * cannot deadlock either: it reaches the door only after the first has settled,
 * and then either admits or refuses on the same two reads.
 *
 * This object owns both maps and is injected into the registry (the teardown
 * side) and into each agent's replacement coordinator (the admission side) as a
 * **required** dependency, so neither side can be constructed without it and
 * neither owns the other. Its lifetime is one adapter instance: the maps are
 * process memory, and a restarted instance builds a fresh arbiter, which is why
 * a crash mid-teardown needs no cleanup path here.
 * @packageDocumentation
 */
import { DeferredPromise } from '@makaio/utils';
import type { AIAgentConnector } from '../connector/index.js';
import { CONNECTOR_EXIT_OBSERVATION_MS, SWAP_SETTLEMENT_WAIT_MS } from '../connector/teardown-timing.js';
import type { TeardownReport } from '../connector/teardown-report.js';
import { aggregateTeardownReports, unknownTeardown } from '../connector/teardown-report.js';
import { ConnectorSwapVetoedError } from './connector-swap-vetoed-error.js';
import type { ConnectorRuntimeHandle } from './connector-runtime.js';

/**
 * A connector runtime seen only as something that can be closed.
 *
 * The arbiter holds handles produced by every agent on one adapter instance, so
 * it cannot carry their connector types; closing is the whole of what it does
 * with them.
 */
export type ClosableConnectorRuntime = ConnectorRuntimeHandle<Pick<AIAgentConnector, 'close'>>;

/**
 * How one connector replacement ended, for the teardown waiting on it.
 *
 * **In-process only, and deliberately not a wire type.** It carries live runtime
 * handles, so it cannot cross a transport and no subject may take it as a
 * payload. Both parties are inside one adapter instance by construction — the map
 * it travels through is this object's own memory — so this is a boundary being
 * written down rather than a limitation being accepted. A future cross-process
 * consumer needs a *reported* form (a class plus a detail), not this one.
 */
export interface ConnectorReplacementSettlement {
  /** Which runtime is current once the replacement is over. */
  readonly outcome: 'committed' | 'rolled-back';
  /**
   * Runtimes this replacement started or superseded and could **not** prove
   * closed.
   *
   * The outcome names which runtime is *current*, which is not the same question
   * as which started resources are still *live*: a committed replacement whose
   * close of the superseded runtime failed leaves that runtime holding its
   * connector and its lease, and a rolled-back one whose close of the replacement
   * failed leaves that one. A waiting teardown closes these too, best-effort, and
   * aggregates — so the outcome stays two-valued and every consumer keeps one
   * branch instead of gaining an "unsafe" third arm.
   */
  readonly unclosed: readonly ClosableConnectorRuntime[];
  /**
   * What the closes this replacement performed **itself** observed.
   *
   * The outcome and `unclosed` together say which runtimes still need closing;
   * neither says how strong the replacement's own closes were. A superseded close
   * that reports `detached` — the ordinary answer of a process connector that
   * signalled a kill it did not see land — fails nothing, so it appears in neither
   * field, and a teardown aggregating only its own closes would then answer for the
   * agent more strongly than the runtime it inherited the end of ever allowed.
   *
   * So the reports travel and the waiting teardown aggregates them with its own.
   * This is the same rule as everywhere else in this seam: whoever is last
   * answerable reports, and the weakest class in the set is the answer.
   */
  readonly closeReports: readonly TeardownReport[];
}

/**
 * What a replacement learns about its waiter at the instant it settles.
 *
 * Two different questions, and a replacement acts on both: *who closes the
 * runtimes* and *who reports the closes already performed*. They are not the same
 * question, because a settlement can have no waiter at all — the ordinary case,
 * with no teardown anywhere — and then nobody abandoned anything and nobody took
 * the reports either.
 */
export interface ConnectorSwapHandover {
  /**
   * A teardown gave up waiting, making both runtimes this replacement's to close.
   *
   * Distinct from the case below: an expired waiter inherits *obligations*, an
   * absent one never had any.
   */
  readonly abandonedByWaiter: boolean;
  /**
   * A teardown received this settlement, so its {@link
   * ConnectorReplacementSettlement.closeReports} are already answered for.
   *
   * `false` covers both an absent waiter and an expired one, and the replacement
   * treats them alike: the reports have no consumer, so they travel to the party
   * that is still answerable for the agent instead of being discarded.
   */
  readonly reportsConsumedByWaiter: boolean;
}

/** The admission a replacement holds between the door and its own `finally`. */
export interface ConnectorSwapAdmission {
  /**
   * Settle this replacement and learn what became of its waiter.
   *
   * Called before the post-settlement work in the `finally` of the very function
   * that took the admission, so a teardown already waiting can proceed. That
   * function retires the admission after its post-settlement work finishes.
   * @param settlement - Which runtime is current, and what could not be proven closed
   * @returns Who closes what is left, and whether anybody took the reports
   */
  settle: (settlement: ConnectorReplacementSettlement) => ConnectorSwapHandover;
  /**
   * Retire this replacement from identity-wide visibility after its own
   * post-settlement obligations finish.
   *
   * Settlement removes only current-runtime handover eligibility so a teardown
   * can proceed. Retirement is deliberately separate: an abandoned waiter makes
   * the coordinator close inherited runtimes after settlement, and no-entry
   * disposal must remain `unknown` until those closes finish. Repeated calls are
   * harmless.
   */
  retire: () => void;
}

/** What a teardown flight needs from the registry that owns the agent. */
export interface TeardownSubject {
  /**
   * Close whichever runtime the agent holds now, and report.
   *
   * Called after any replacement has settled, which is what makes "the runtime
   * current for that outcome" automatic: a committed replacement published its
   * own, a rolled-back one restored the previous.
   */
  readonly closeCurrent: () => Promise<TeardownReport>;
  /**
   * Close one runtime a settlement could not prove closed.
   * @param runtime - Handle reported as unclosed
   */
  readonly closeUnclosed: (runtime: ClosableConnectorRuntime) => Promise<TeardownReport>;
  /**
   * Give the agent's identity up without closing anything.
   *
   * Separate from the closes because the two are separable: an agent stops being
   * the instance that answers for its ID at the instant this teardown gives up on
   * it, whatever the connector replacement it abandoned later does with the
   * runtimes. Only the expiry arm calls it — every other arm reaches
   * `AIAgent.close()`, which takes the wiring down itself.
   */
  readonly releaseIdentity: () => void;
  /**
   * Absolute deadline of the request driving this teardown, when it has one.
   *
   * Present for an RPC-driven stop, absent for a session close that fans out
   * over every agent it owns — which is exactly the path where the policy
   * ceiling stands alone.
   */
  readonly deadline?: number | undefined;
}

/** A replacement in flight, plus the one bit its waiter may set. */
interface SwapEntry {
  /** Resolves — never rejects — once the replacement is over. */
  readonly settlement: Promise<ConnectorReplacementSettlement>;
  /**
   * Set by a teardown that gave up waiting.
   *
   * Read by the door in its `finally`: when the waiter is gone, the replacement
   * closes **both** runtimes itself, because the party that was going to close the
   * survivor no longer exists. The ordinary lid rather than an anomaly's backstop —
   * expiry against a legal slow replacement is a specified normal path.
   */
  abandonedByWaiter: boolean;
  /**
   * Set by a teardown that entered the wait for this settlement.
   *
   * The other half of {@link ConnectorSwapHandover.reportsConsumedByWaiter}: a
   * waiter that entered the wait and did not abandon it **will** receive the
   * settlement, because this flag is captured before the entry resolves and a
   * resolved race cannot then lose to its own timer. So the two flags together
   * distinguish the three states a settlement can be in — nobody waited, a waiter
   * took it, a waiter gave up — where one flag can only distinguish two.
   */
  awaitedByWaiter: boolean;
  /** The handover returned by the first settlement. */
  handover: ConnectorSwapHandover | undefined;
  /** Whether this admission has left identity-wide replacement visibility. */
  retired: boolean;
}

/** Arbitrate teardowns and connector replacements for one adapter instance. */
export class AgentTeardownArbiter {
  /**
   * Teardowns in flight, keyed by agent.
   *
   * Installed **before** any close starts and removed in a `finally`, which is
   * what makes joining total: a second caller reads the answer the first is
   * already producing, and a reentrant close triggered by the first one's own
   * lifecycle event joins the flight that emitted it.
   */
  private readonly teardowns = new Map<string, Promise<TeardownReport>>();
  /** The newest replacement eligible to hand a teardown its current runtime. */
  private readonly swaps = new Map<string, SwapEntry>();
  /** Replacements with post-settlement obligations, keyed by agent. */
  private readonly swapRetirementCounts = new Map<string, number>();

  /**
   * Whether a teardown of this agent is in flight.
   *
   * "Nothing here" is only true when nothing is in flight, so a caller answering
   * that question asks this one too rather than reading the registry alone.
   * @param agentId - Agent to probe
   * @returns Whether a flight is installed for it
   */
  public hasTeardownInFlight(agentId: string): boolean {
    return this.teardowns.has(agentId);
  }

  /**
   * Whether a connector replacement of this agent is in flight.
   *
   * **The state an expiry leaves behind.** A teardown that gave up waiting removes
   * its own flight and its registry entry, while the replacement it abandoned still
   * holds *both* runtimes and closes neither until it settles. So a caller
   * answering "nothing on this instance can still be speaking for that identity"
   * asks this question too: without it, the one answer that frees an identity is
   * given while two live connectors answer for it.
   *
   * **Any** admitted replacement counts until its retirement, not only the newest:
   * a superseded predecessor holds runtimes and closes them on its own schedule,
   * so an identity is free only once every replacement admitted on it has finished
   * its post-settlement obligations.
   * @param agentId - Agent to probe
   * @returns Whether a replacement is installed for it
   */
  public hasReplacementInFlight(agentId: string): boolean {
    return this.swapRetirementCounts.has(agentId);
  }

  /**
   * Admit a connector replacement, or refuse it.
   *
   * **The door, and the entire boundary between the two acts.** It is a
   * synchronous prologue with no await between its steps, which is what makes the
   * two arbitration regions exhaustive: a teardown is either installed before this
   * instant or it is not, and there is no interval in between for one to arrive
   * in.
   *
   * Refusing costs nothing here — no replacement runtime exists yet, no provider
   * thread has been started, no lifecycle event has been delivered and no account
   * transition has been committed. Whatever a producer did *before* reaching the
   * door is the producer's own to compensate, which every producer already does.
   * @param agentId - Agent whose connector would be replaced
   * @param hasConnectorRuntime - Read of the agent's runtime presence, evaluated
   *   inside the prologue so its refusal is ordered after the teardown read
   * @returns The admission whose settlement the door must resolve
   * @throws ConnectorSwapVetoedError When a teardown is in flight, or the agent
   *   holds no runtime to replace
   */
  public admitSwap(agentId: string, hasConnectorRuntime: () => boolean): ConnectorSwapAdmission {
    if (this.teardowns.has(agentId)) {
      throw new ConnectorSwapVetoedError(agentId, 'teardown-in-flight');
    }
    if (!hasConnectorRuntime()) {
      throw new ConnectorSwapVetoedError(agentId, 'no-runtime');
    }
    const deferred = new DeferredPromise<ConnectorReplacementSettlement>();
    const entry: SwapEntry = {
      settlement: deferred.getPromise(),
      abandonedByWaiter: false,
      awaitedByWaiter: false,
      handover: undefined,
      retired: false,
    };
    // A successor owns the current-runtime decision; predecessors remain counted
    // until they retire because post-settlement closes can still hold runtimes for
    // this identity.
    this.swaps.set(agentId, entry);
    this.swapRetirementCounts.set(agentId, (this.swapRetirementCounts.get(agentId) ?? 0) + 1);
    return {
      settle: (settlement) => {
        if (entry.handover !== undefined) return entry.handover;
        // Capture the handover, resolve, then remove — all synchronously. The
        // waiter's continuation is a microtask that cannot interleave, and the
        // stored handover also makes an accidental repeated settlement harmless.
        const { abandonedByWaiter, awaitedByWaiter } = entry;
        const handover = { abandonedByWaiter, reportsConsumedByWaiter: awaitedByWaiter && !abandonedByWaiter };
        entry.handover = handover;
        deferred.resolve(settlement);
        // Settlement only ends current-runtime handover eligibility. Identity
        // visibility remains until the coordinator retires post-settlement work.
        if (this.swaps.get(agentId) === entry) this.swaps.delete(agentId);
        return handover;
      },
      retire: () => {
        if (entry.handover === undefined || entry.retired) return;
        entry.retired = true;
        const remaining = (this.swapRetirementCounts.get(agentId) ?? 1) - 1;
        if (remaining === 0) this.swapRetirementCounts.delete(agentId);
        else this.swapRetirementCounts.set(agentId, remaining);
      },
    };
  }

  /**
   * Run — or join — the single teardown flight for one agent.
   *
   * The flight **writes no status**: the four entry points want different
   * terminal effects, so a plan carried into the flight would make the terminal
   * status depend on which caller won the race, and applying the effects after a
   * join would write it twice. Removing status from the flight dissolves both, and
   * costs nothing because the statuses are already idempotent — `disposed` is
   * terminal in storage, so the *effective* terminal status is `disposed` whenever
   * a disposal participated, in either order.
   *
   * Reading the replacement map is the flight's **first act after installing its
   * own entry**, and that order is what makes the arbitration total: a replacement
   * beginning after the install finds this flight and refuses, one that began
   * before it is awaited rather than raced.
   *
   * **The install happens before the body runs, not after it returns.** An async
   * function runs synchronously up to its first await, and the body reaches
   * `closeCurrent()` — and through it `agent.session.closed` — inside that window.
   * Writing the map with the promise the body returned would leave a synchronously
   * reentrant teardown unable to see the flight that provoked it, making
   * reentrancy safe only by the emitter's scheduling rather than by construction.
   * A deferred promise is what makes the installation first.
   * @param agentId - Agent being torn down
   * @param subject - How to close this agent's runtimes, and the caller's deadline
   * @returns What the teardown observed — the joined answer for a second caller
   */
  public runTeardown(agentId: string, subject: TeardownSubject): Promise<TeardownReport> {
    const joined = this.teardowns.get(agentId);
    if (joined !== undefined) return joined;
    const deferred = new DeferredPromise<TeardownReport>();
    const flight = deferred.getPromise();
    this.teardowns.set(agentId, flight);
    void this.settleFlight(agentId, subject, deferred);
    return flight;
  }

  /**
   * Run the flight body and hand its answer to the installed promise.
   *
   * Separated from {@link runTeardown} so the installation stays synchronous: this
   * is the first thing that may await, and by the time it does the map already
   * carries the flight. The removal is in a `finally` and therefore runs in the same
   * synchronous continuation as the settlement, so no joiner can resume and find
   * the entry still there.
   * @param agentId - Agent being torn down
   * @param subject - How to close this agent's runtimes, and the caller's deadline
   * @param deferred - The promise already installed for this flight
   */
  private async settleFlight(
    agentId: string,
    subject: TeardownSubject,
    deferred: DeferredPromise<TeardownReport>,
  ): Promise<void> {
    try {
      deferred.resolve(await this.flyTeardown(agentId, subject));
    } catch (error) {
      // The body reports instead of rejecting, so this is the guard for an edit
      // that breaks that invariant rather than a path taken today: a joiner must
      // never be left waiting on a promise nobody settles.
      deferred.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.teardowns.delete(agentId);
    }
  }

  /**
   * The flight body: arbitrate against any replacement, then close.
   * @param agentId - Agent being torn down
   * @param subject - How to close this agent's runtimes, and the caller's deadline
   * @returns What the teardown observed
   */
  private async flyTeardown(agentId: string, subject: TeardownSubject): Promise<TeardownReport> {
    // Only the current replacement decides this agent's current runtime. A settled
    // successor must not make a teardown inherit an older predecessor's runtime.
    const swap = this.swaps.get(agentId);
    if (swap === undefined) return reportedClose(subject.closeCurrent());

    const settlement = await this.awaitSettlement(swap, subject.deadline);
    if (settlement === undefined) {
      // **The identity is given up here, where it becomes free.** The wrapper
      // removes the registry entry on this arm too, so the ID is claimable from
      // this instant — while the replacement that inherited the runtimes may not
      // settle for another whole wait. Unsubscribing the agent only then would
      // leave a successor answering beside it for the whole window. Giving an
      // identity up is a routability act and not a close, which is why it belongs
      // on the arm that closes nothing.
      subject.releaseIdentity();
      // **Closing nothing is the only correct arm.** The replacement is still
      // running, and closing the runtime under it would let a recovering
      // replacement publish onto an agent already declared dead — the orphan the
      // refusal region exists to prevent. So the teardown reports what it does
      // not know, which is exactly true: a connector may still be live, and
      // nobody may pretend otherwise. The resources are not lost either: the
      // abandoned flag hands both runtimes to the replacement.
      return unknownTeardown(
        `Agent ${agentId} had an unsettled connector replacement in flight; nothing was closed and the replacement now owns both runtimes.`,
      );
    }

    // The replacement's own closes are part of this agent's end, so they are part
    // of this teardown's report. Included **before** anything is closed here so a
    // later edit cannot make the aggregate depend on how many closes this arm
    // performs: the set is what ended, and its weakest class is the answer.
    const reports = [...settlement.closeReports, await reportedClose(subject.closeCurrent())];
    for (const runtime of settlement.unclosed) {
      reports.push(await reportedClose(subject.closeUnclosed(runtime)));
    }
    return aggregateTeardownReports(reports);
  }

  /**
   * Wait for a replacement to settle, bounded by the caller's own budget.
   *
   * **The waiter takes its own bound**, because a contract may not claim
   * boundedness while making a teardown wait on somebody else's discipline. The
   * effective wait is the smaller of the policy ceiling and what remains of the
   * caller's deadline less one observation margin; the margin is that constant
   * because the expiry arm closes nothing, so all that remains after it is a
   * status write and the reply.
   *
   * **What this bound proves, and nothing beyond it:** the wait itself always
   * expires with at least one observation margin of the caller's budget
   * unconsumed, so it can never consume the whole outer budget on its own.
   * Response *reachability* stays best-effort while the post-wait tail is
   * unbounded — a caller whose deadline expires receives its timeout by bus law,
   * and from inside here that is indistinguishable from the tail being slow.
   *
   * Below the margin the clamp yields a **zero wait**: the teardown does not wait
   * at all and answers as fast as it can. Marking the abandonment synchronously in
   * that arm is load-bearing — it must be visible to a door whose own settlement
   * has already resolved.
   * @param swap - Replacement entry found in flight
   * @param deadline - Absolute deadline of the request driving this teardown
   * @returns The settlement, or `undefined` when the bound expired first
   */
  private async awaitSettlement(
    swap: SwapEntry,
    deadline: number | undefined,
  ): Promise<ConnectorReplacementSettlement | undefined> {
    // Marked before the bound is even computed, because the flag says *a teardown
    // came for this settlement* — not *a teardown waited successfully*. A zero-wait
    // arm still abandons the entry, and the abandonment flag is what distinguishes
    // it from a waiter that took the answer.
    swap.awaitedByWaiter = true;
    const effectiveWaitMs =
      deadline === undefined
        ? SWAP_SETTLEMENT_WAIT_MS
        : Math.min(SWAP_SETTLEMENT_WAIT_MS, Math.max(0, deadline - Date.now() - CONNECTOR_EXIT_OBSERVATION_MS));
    if (effectiveWaitMs <= 0) {
      swap.abandonedByWaiter = true;
      return undefined;
    }

    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<undefined>((resolve) => {
      expiryTimer = setTimeout(() => resolve(undefined), effectiveWaitMs);
    });
    try {
      const settlement = await Promise.race([swap.settlement, expiry]);
      if (settlement === undefined) swap.abandonedByWaiter = true;
      return settlement;
    } finally {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    }
  }
}

/**
 * Make a close report even when it throws.
 *
 * **The flight must never reject**, and this is what guarantees it. Every wrapper
 * around a flight has an obligation left to discharge after the close — a terminal
 * status write, a rethrow its own consumer aggregates on, a reply — and a rejected
 * flight would skip all of them, leaving an agent gone from the registry with its
 * row still claiming to be alive. The layers below normally convert their own
 * failures already; this is the guard for a `close()` override that does not.
 * @param close - Close whose report is wanted whatever it does
 * @returns The report, or `unknown` carrying the failure that replaced it
 */
async function reportedClose(close: Promise<TeardownReport>): Promise<TeardownReport> {
  try {
    return await close;
  } catch (error) {
    return unknownTeardown(
      `Teardown threw instead of reporting: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}
