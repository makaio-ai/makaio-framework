/**
 * I33 — a runtime may not start a replacement resource generation before it has
 * retired its predecessor's, and *retiring* means consuming that predecessor's
 * own end evidence.
 *
 * Some connectors replace an operating-system process **inside themselves**: a
 * late system prompt forces a rebuild, a failed handshake forces a reconnect. No
 * runtime handle exists for the superseded generation, so the layers above
 * cannot see it and cannot report it — the connector is the last party that can.
 * This is the same idea as an unclosed runtime one layer down, deliberately: a
 * resource whose end nobody proved travels to whoever can still report it, and
 * the reported class *is* the report.
 *
 * The ledger holds one fact and derives the rule from it: **a superseded
 * generation is unproven until its end has actually been observed.** It becomes
 * unproven the moment it is superseded — not when a wait for it expires — because
 * the window in between is precisely when a teardown can arrive and would
 * otherwise claim a class for a resource nobody had watched. A generation leaves
 * the ledger when its end is observed, whenever that is: inside the observation
 * budget a caller waited for, or later. Until then — and for good when its end
 * never arrives, or when it exposed no observation at all — no class the
 * connector reports may be stronger than `detached`.
 *
 * The evidence is an {@link ExitObservation}: a promise that fulfils on an
 * observation only. An end report, which also fulfils for an end nobody saw, is
 * refused by type when it is passed as such; see {@link ExitObservation} for what
 * the type cannot see, such as a promise widened to `Promise<unknown>`.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { capTeardownEvidence, exitWasObserved, type ExitObservation } from './teardown-observation.js';

/** One resource generation taken out of service, with the end still to consume. */
export interface SupersededGeneration {
  /** Monotonic number of this generation within its connector, for diagnostics. */
  readonly generation: number;
  /**
   * The superseded generation's own end observation, accepted only as an
   * {@link ExitObservation} by {@link GenerationRetirementLedger.supersede}.
   * Typed loosely here because the ledger hands it back after that check; a
   * generation built by hand bypasses the check and must carry an observation
   * that fulfils on an observed end only.
   *
   * `undefined` when the generation exposed none — which is itself a
   * non-observation and is recorded as one, because "we never had a way to look"
   * and "we looked and saw nothing" put a consumer in the same position.
   */
  readonly exited: Promise<unknown> | undefined;
}

/**
 * Records which of a connector's superseded resource generations were never
 * observed to end.
 *
 * One per connector instance. Deliberately generic: I33 binds every connector
 * that replaces a resource inside itself, including ones that do not exist yet,
 * and a rule implemented twice is a rule that will hold in one place.
 */
export class GenerationRetirementLedger {
  /** Count of generations taken out of service, used to number them. */
  private supersededCount = 0;

  /**
   * Generations whose end is not (yet) proven — retirement pending or given up on.
   *
   * A generation enters the moment it is superseded and leaves only when its end
   * has actually been observed. That is deliberate: a retirement still in flight
   * is a resource whose end nobody has proven, and a teardown arriving during one
   * must not be able to claim an observed class in the window before the wait
   * expires. Pending and abandoned are the same fact to every consumer — "no
   * proof" — so they are one set rather than two that could disagree.
   */
  private readonly unproven = new Set<number>();

  /**
   * @param resource - What a generation of this resource is, for the `detail`
   *   an unretired generation puts on every later teardown. Names the thing
   *   that may still be running ("qwen ACP process"), because that is what a
   *   human triaging the capped class needs to go looking for.
   */
  public constructor(private readonly resource: string) {}

  /**
   * Take the live generation out of service and hand back what must be consumed.
   *
   * Called at the single choke point through which a connector retires a
   * generation, so the count cannot drift from the replacements that actually
   * happened. The caller has already signalled the end; this only opens the
   * bookkeeping for it.
   *
   * The generation counts as **unproven from this moment**, not from the moment a
   * wait for it expires. Between the two a teardown could otherwise arrive and
   * claim an observed class for a resource nobody had watched end yet.
   * @typeParam T - Fulfilment value of the observation.
   * @param exited - The superseded generation's own end observation, if it has
   *   one. Must fulfil on an observation only; an end report is refused by type.
   * @returns The generation to retire, to pass to {@link retire} or {@link abandon}.
   */
  public supersede<T>(exited: ExitObservation<T> | undefined): SupersededGeneration {
    this.supersededCount += 1;
    const generation = { generation: this.supersededCount, exited };
    this.unproven.add(generation.generation);
    return generation;
  }

  /**
   * Consume a superseded generation's end inside the observation budget.
   *
   * The budget is the same constant a connector spends observing its own
   * termination, because "did the resource end" is one question whether it is
   * asked of a connector or of a superseded generation of one.
   *
   * Expiry does **not** fail the replacement: a stuck predecessor must not block
   * a live agent, so the rebuild completes and the non-observation is carried in
   * the class instead. Expiry ends the caller's wait, not the ledger's: like
   * {@link abandon}, it keeps watching, so an end observed after the budget still
   * retires the generation and lifts the cap from every later report.
   * @param generation - Generation returned by {@link supersede}.
   * @returns Whether the generation's end was observed inside the budget.
   */
  public async retire(generation: SupersededGeneration): Promise<boolean> {
    if (generation.exited === undefined) return false;
    this.watchForEnd(generation);
    if (!(await exitWasObserved(generation.exited))) return false;
    this.unproven.delete(generation.generation);
    return true;
  }

  /**
   * Record a generation as unretired without waiting for its end.
   *
   * The synchronous half of the split: a connector's `abort()` is synchronous by
   * contract and cannot await anything, so it signals the end and gives up on
   * observing it. Capping the class is what keeps that from being a hole —
   * without it, a synchronous retirement would silently claim what an asynchronous
   * one has to prove.
   *
   * The caller still does not wait, but the ledger continues observing the end it
   * already holds. Once that promise fulfils, the generation is proven retired and
   * no longer caps later teardowns. A rejected observation remains unproven: it
   * did not establish that the resource ended.
   * @param generation - Generation returned by {@link supersede}.
   */
  public abandon(generation: SupersededGeneration): void {
    this.unproven.add(generation.generation);
    this.watchForEnd(generation);
  }

  /**
   * Retire a generation once its end is observed, however late. A rejected
   * observation leaves it unproven: it did not establish that the resource ended.
   * @param generation - Generation returned by {@link supersede}.
   */
  private watchForEnd(generation: SupersededGeneration): void {
    void generation.exited?.then(
      () => this.unproven.delete(generation.generation),
      () => undefined,
    );
  }

  /**
   * Apply the ceiling every unproven generation puts on a reported class.
   *
   * A no-op while every generation's end was observed, so a connector may call it
   * unconditionally on its way out and no caller has to remember the rule.
   * @param result - Class the teardown computed for what it did observe.
   * @returns The class capped at `detached` while a generation's end is unproven.
   */
  public capReport(result: ConnectorTeardownResult): ConnectorTeardownResult {
    const detail = this.unretiredDetail();
    if (detail === undefined) return result;
    return capTeardownEvidence(result, 'detached', detail);
  }

  /**
   * Name the generations whose end this connector has not observed.
   * @returns The diagnostic, or `undefined` when every end was observed.
   */
  public unretiredDetail(): string | undefined {
    if (this.unproven.size === 0) return undefined;
    const numbers = [...this.unproven].join(', ');
    return `${this.resource} generation ${numbers} was superseded without its end being observed and may still be running.`;
  }
}
