/**
 * What a host learns when it closes an adapter instance.
 *
 * The instance layer sits above every connector and below nobody: when a runtime
 * shuts down, this is the last place that can still say whether the adapters it
 * hosted actually let go. It used to say nothing — a close hook that timed out and
 * one that returned were both "no error was logged" — so the taxonomy is applied
 * here too, with the classes this layer can honestly prove:
 *
 * - **`released`** — the instance exposes no close hook, so there is nothing to
 *   tear down and nothing can still be speaking through it.
 * - **`detached`** — the hook returned inside its budget. That proves the call
 *   completed and *nothing more*: the hook's own return type carries no class, so
 *   whatever the adapter held may still be running.
 * - **`unknown`** — the hook timed out or threw. Nothing is known, and this is the
 *   distinction the previous implementation could not make.
 *
 * A timeout is therefore never a clean close, which is the whole point of the
 * module.
 * @packageDocumentation
 */
import type { ConnectorTeardownResult } from '@makaio/contracts';
import { aggregateTeardownResults } from '@makaio/contracts';

/** One adapter instance's teardown, named so a caller can act per instance. */
export interface AdapterInstanceTeardownResult extends ConnectorTeardownResult {
  /** Runtime adapter ID whose instance this result belongs to. */
  readonly adapterId: string;
}

/**
 * Every instance teardown of one shutdown, plus the class standing for all of them.
 *
 * Both halves are carried because they answer different questions: the aggregate
 * is what a future instance retirement branches on, and the per-instance results
 * are what a human triaging a weak aggregate needs in order to find the adapter
 * responsible for it.
 */
export interface AdapterInstanceShutdownReport extends ConnectorTeardownResult {
  /** One result per instance that was live, in shutdown order. */
  readonly results: readonly AdapterInstanceTeardownResult[];
}

/**
 * The failure a close hook that outlived its budget produces.
 *
 * A distinct type rather than a message, because the two failures this layer can
 * see mean different things to whoever reads the report: a hook that **threw**
 * reported its own failure, a hook that **timed out** reported nothing at all and
 * may still be running. Both are `unknown`, and a reader that has to tell them
 * apart should not be parsing prose to do it.
 */
export class AdapterInstanceCloseTimeoutError extends Error {
  /**
   * @param adapterId - Runtime adapter ID whose close hook did not return.
   * @param timeoutMs - Budget the hook was given.
   */
  public constructor(
    public readonly adapterId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Timed out closing adapter ${adapterId} after ${timeoutMs}ms`);
    this.name = 'AdapterInstanceCloseTimeoutError';
  }
}

/**
 * Classify one attempted instance close.
 *
 * Declared beside the taxonomy it applies rather than inside the shutdown loop, so
 * the rule stays readable and a second caller cannot restate it differently.
 * @param adapterId - Runtime adapter ID being closed.
 * @param failure - Failure the attempt produced, or `undefined` when it returned.
 * @param hadCloseHook - Whether the instance exposed a close hook at all.
 * @returns The class this attempt proves, with a `detail` for the weak ones.
 */
export function classifyAdapterInstanceClose(
  adapterId: string,
  failure: unknown,
  hadCloseHook: boolean,
): AdapterInstanceTeardownResult {
  if (failure instanceof AdapterInstanceCloseTimeoutError) {
    return {
      adapterId,
      evidence: 'unknown',
      detail: `Adapter ${adapterId} did not return from its close hook within ${failure.timeoutMs}ms; whatever it holds may still be running.`,
    };
  }
  if (failure !== undefined) {
    return {
      adapterId,
      evidence: 'unknown',
      detail: `Adapter ${adapterId} close hook failed: ${failure instanceof Error ? failure.message : String(failure)}`,
    };
  }
  if (!hadCloseHook) {
    return { adapterId, evidence: 'released' };
  }
  return {
    adapterId,
    evidence: 'detached',
    detail: `Adapter ${adapterId} returned from its close hook without reporting a class, so what it held is unproven.`,
  };
}

/**
 * Reduce every instance teardown of one shutdown to the report a host publishes.
 *
 * Class and joined `detail` come from the contract's
 * {@link aggregateTeardownResults} — the weakest in the set, `released` for an
 * empty set — so a shutdown that hosted nothing and one whose adapters all let go
 * answer the same, which is correct for every consumer of "may this instance be
 * retired". What this layer adds is the per-instance breakdown the aggregate was
 * derived from.
 * @param results - Per-instance results, in shutdown order.
 * @returns The aggregate class plus the results it was derived from.
 */
export function aggregateAdapterInstanceTeardowns(
  results: readonly AdapterInstanceTeardownResult[],
): AdapterInstanceShutdownReport {
  return { ...aggregateTeardownResults(results), results };
}
