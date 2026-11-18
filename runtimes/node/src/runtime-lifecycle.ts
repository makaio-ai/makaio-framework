/**
 * Lifecycle handle of one runtime, from before it boots until it has stopped.
 *
 * A host that boots a runtime has to answer one question when a stop request
 * arrives: what does stopping mean right now? While the runtime boots, stopping
 * cancels the boot and waits for its rollback; once it has booted, stopping
 * shuts it down. The two phases have different time limits, and the request can
 * arrive in either. This handle owns that answer, so a host does not hand-write
 * the glue between its boot, its shutdown and the limits of each.
 * @packageDocumentation
 */

import { readCancellation } from '@makaio/kernel';
import { JoinedOperation, outerBoundMs } from '@makaio/utils';
import { resourceStepStopBudgetMs } from './runtime-stop-budget.js';
import type { HostShutdown, HostShutdownStep } from './host-shutdown.js';
import type { CoreBootOptions, MakaioRuntime } from './boot-types.js';

/** What a lifecycle needs of the runtime it manages; every {@link MakaioRuntime} provides it. */
export type LifecycleRuntime = Pick<MakaioRuntime, 'shutdown' | 'stopBudgetMs'>;

/**
 * The boot options the lifecycle owns. A host spreads them into the options of
 * its boot call, whichever platform boot it uses; they are what ties the boot
 * to the lifecycle.
 */
export type LifecycleBootHooks = Required<Pick<CoreBootOptions, 'signal' | 'onCancellationBudget'>>;

/** Inputs to {@link createRuntimeLifecycle}. */
export interface RuntimeLifecycleOptions {
  /**
   * A cancellation source the host already has (for example the signal of a CLI
   * command). When it aborts, the boot is cancelled exactly as if
   * {@link RuntimeLifecycle.stop} had been called, and the lifecycle's own signal
   * carries its reason.
   */
  readonly cancellation?: AbortSignal;
}

/**
 * Handle of one runtime's lifecycle.
 * @typeParam TRuntime - The runtime the handle manages.
 */
export interface RuntimeLifecycle<TRuntime extends LifecycleRuntime = MakaioRuntime> {
  /**
   * Aborted as soon as a stop is requested, with the cause as reason (and when
   * the {@link RuntimeLifecycleOptions.cancellation} source aborts). It is the
   * signal of the boot, so `signal.aborted` tells a host that a boot which
   * ended was ended by a stop request rather than by a failure of its own.
   */
  readonly signal: AbortSignal;
  /** The booted runtime; `undefined` until the boot has succeeded. */
  readonly runtime: TRuntime | undefined;
  /**
   * Boot the runtime under the lifecycle. The boot gets the lifecycle's
   * cancellation and reports its cancellation bound, which is what makes
   * {@link stop} work while it runs. A lifecycle boots one runtime.
   * @param start - Calls the platform boot with the hooks spread into its options.
   * @returns What the boot resolves with; a boot that a stop cancelled rejects
   *   with the cancellation reason, or with an `AggregateError` of the cleanup
   *   failures when its rollback failed (see `cancellationRejection` in `@makaio/kernel`).
   * @throws When a runtime was already booted or is booting.
   */
  boot(start: (hooks: LifecycleBootHooks) => Promise<TRuntime>): Promise<TRuntime>;
  /**
   * Stop the runtime, whatever phase it is in. Before a boot, nothing is
   * running and nothing happens (a boot that starts afterwards is cancelled at its
   * first checkpoint). During the boot, the boot is cancelled and its rollback
   * awaited. After it, the runtime is shut down; a boot that finished before it
   * saw the request is shut down too. The first call starts the stop; later ones
   * join it, until it has failed: the next call after a failure starts a new attempt.
   * @param reason - What asked for the stop, e.g. a signal name.
   * @returns Settles when the runtime is down. Rejects with the cleanup failures
   *   when the rollback of a cancelled boot or the runtime shutdown failed; a boot
   *   that failed on its own is not rejected here, its caller already has that failure.
   */
  stop(reason?: string): Promise<void>;
  /**
   * How long {@link stop} takes at most, in milliseconds: the boot's cancellation
   * bound while it runs, the runtime's own {@link MakaioRuntime.stopBudgetMs}
   * once it has booted. A phase reads the bound afresh, so what the boot has
   * registered so far counts.
   * @returns The bound, or `undefined` when nothing is running: before the boot
   *   has reported one, and after a boot that ended without a runtime.
   */
  stopBudgetMs(): number | undefined;
  /**
   * The teardown stage that stops the runtime, for {@link installHostShutdown}.
   * Its window is the bound {@link stopBudgetMs} reports plus the headroom of an
   * outer bound (`outerBoundMs`): the runtime and the boot enforce their own
   * limits, so the host's timer is a backstop for one that does not hold to its
   * bound, never the thing that limits it. While no bound is known the window is
   * one bounded stop (`resourceStepStopBudgetMs`), so the stage is never unbounded.
   * @param name - Name the report of a stage that did not finish uses.
   * @returns The stage.
   */
  shutdownStep(name?: string): HostShutdownStep;
}

/**
 * Reason {@link bootUnderShutdown} gives the shutdown it requests when the boot
 * failed on its own. A host that ends itself once its shutdown has finished tells
 * this request apart from a stop: a failed boot is a failure, which the host reports
 * by letting the failure surface, not by exiting cleanly.
 */
export const BOOT_FAILURE_SHUTDOWN_REASON = 'boot failure';

/**
 * Reason {@link bootUnderShutdown} gives the shutdown it requests when the
 * lifecycle was cancelled by its own external source
 * ({@link RuntimeLifecycleOptions.cancellation}) rather than by the shutdown: the
 * host's teardown has to run all the same.
 */
const BOOT_CANCELLED_SHUTDOWN_REASON = 'boot cancelled';

/** How the boot ended, as far as {@link RuntimeLifecycle.stop} needs to know. */
type BootEnd =
  | { readonly kind: 'ready' }
  /** The boot rejected; `error` is what it rejected with. */
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Create the lifecycle handle of a runtime.
 * @typeParam TRuntime - The runtime the handle manages.
 * @param options - Optional external cancellation source.
 * @returns The handle; nothing is booted yet.
 */
export function createRuntimeLifecycle<TRuntime extends LifecycleRuntime = MakaioRuntime>(
  options: RuntimeLifecycleOptions = {},
): RuntimeLifecycle<TRuntime> {
  const controller = new AbortController();
  const signal =
    options.cancellation === undefined ? controller.signal : AbortSignal.any([controller.signal, options.cancellation]);

  let runtime: TRuntime | undefined;
  // `undefined` until a boot started; settles when it ended, whatever way.
  let bootEnd: Promise<BootEnd> | undefined;
  // The boot's own bound on how long cancelling it takes, reported as soon as it starts.
  let bootCancellationBudgetMs: (() => number) | undefined;
  let bootEnded = false;
  const stopping = new JoinedOperation<void>();

  const boot = (start: (hooks: LifecycleBootHooks) => Promise<TRuntime>): Promise<TRuntime> => {
    if (bootEnd !== undefined) throw new Error('[runtime-lifecycle] a runtime was already booted by this lifecycle');
    const attempt = start({
      signal,
      onCancellationBudget: (stopBudgetMs) => {
        bootCancellationBudgetMs = stopBudgetMs;
      },
    });
    // Observed before the caller's continuation, so a caller that sees the boot
    // end also sees `runtime` and `stopBudgetMs()` in their final state.
    const observed = attempt.then(
      (booted): TRuntime => {
        runtime = booted;
        bootEnded = true;
        return booted;
      },
      (error: unknown): never => {
        bootEnded = true;
        throw error;
      },
    );
    bootEnd = observed.then(
      (): BootEnd => ({ kind: 'ready' }),
      (error: unknown): BootEnd => ({ kind: 'failed', error }),
    );
    return observed;
  };

  const currentRuntime = (): TRuntime | undefined => runtime;

  const run = async (reason: string): Promise<void> => {
    if (!signal.aborted) controller.abort(new Error(`[runtime-lifecycle] stopped: ${reason}`));
    if (bootEnd === undefined) return;
    // A runtime that is up is shut down in this turn; only a boot still in flight is waited for.
    if (runtime !== undefined) return runtime.shutdown();
    const end = await bootEnd;
    // The boot may have succeeded while it was awaited; the compiler cannot see the assignment.
    const booted = currentRuntime();
    if (end.kind === 'failed') {
      // A boot a stop cancelled rolled itself back. When that rollback failed, its
      // rejection (the aggregate that names the cancellation as its cause) is what this
      // stop has to report; any other failure of the boot is its caller's.
      const failures = readCancellation(end.error, signal);
      if (failures !== undefined && failures.length > 0) throw end.error;
      return;
    }
    await booted?.shutdown();
  };

  const stopBudgetMs = (): number | undefined => {
    if (runtime !== undefined) return runtime.stopBudgetMs();
    return bootEnded ? undefined : bootCancellationBudgetMs?.();
  };

  const stop = (reason = 'stop requested'): Promise<void> =>
    // A stop that failed is not kept: the runtime's shutdown reports what it could not release
    // and can be asked again, so the next caller gets a new attempt rather than the same failure.
    // The run is published before it starts, so a listener of `signal` that stops again joins it.
    stopping.join((forget) =>
      run(reason).catch((error: unknown) => {
        forget();
        throw error;
      }),
    );

  return {
    signal,
    get runtime() {
      return runtime;
    },
    boot,
    stop,
    stopBudgetMs,
    shutdownStep: (name = 'runtime') => ({
      name,
      // Before the boot has reported a bound, or once it ended without a runtime, nothing
      // tells how long the stop takes; the stage is bounded by one bounded stop then.
      budgetMs: () => outerBoundMs(stopBudgetMs() ?? resourceStepStopBudgetMs()),
      run: () => stop(),
    }),
  };
}

/**
 * Boot a runtime under a host shutdown, for a host that ends when its runtime does
 * not come up.
 *
 * A stop request that interrupts the boot cancels it through the boot's own
 * rollback; the shutdown (which owns the rest of the host's cleanup) then runs
 * and finishes. A boot that fails on its own goes through the shutdown too, so
 * its signal listeners and step windows stay in force until that cleanup has
 * finished.
 * @typeParam TRuntime - The runtime the lifecycle manages.
 * @param lifecycle - Lifecycle whose steps the shutdown runs.
 * @param shutdown - The host shutdown installed for this host.
 * @param start - Calls the platform boot with the lifecycle's hooks.
 * @returns The booted runtime, or `undefined` when a stop request ended the host
 *   first: the shutdown has finished then and the host has nothing left to do.
 * @throws The boot's failure, once the shutdown has finished; for a boot that a stop
 *   cancelled only when its rollback failed.
 */
export async function bootUnderShutdown<TRuntime extends LifecycleRuntime>(
  lifecycle: RuntimeLifecycle<TRuntime>,
  shutdown: Pick<HostShutdown, 'cancellation' | 'request' | 'finished'>,
  start: (hooks: LifecycleBootHooks) => Promise<TRuntime>,
): Promise<TRuntime | undefined> {
  let booted: TRuntime;
  try {
    booted = await lifecycle.boot(start);
  } catch (err) {
    const interrupted = lifecycle.signal.aborted;
    await (interrupted ? endInterruptedBoot(shutdown) : shutdown.request(BOOT_FAILURE_SHUTDOWN_REASON));
    // A boot a stop cancelled is a clean end, unless its rollback failed
    // (then `err` is an AggregateError and the cancellation reason is its cause).
    if (interrupted && err === lifecycle.signal.reason) return undefined;
    throw err;
  }
  if (lifecycle.signal.aborted) {
    // The boot completed before it could see the request; the shutdown tears the finished runtime down.
    await endInterruptedBoot(shutdown);
    return undefined;
  }
  return booted;
}

/**
 * Wait for the host teardown of a boot that was interrupted, requesting it when no
 * stop request did: the lifecycle also aborts from an external cancellation source,
 * which does not know the host's shutdown, and the resources the host owns (its
 * server, its signal listeners) are released only by that teardown.
 * @param shutdown - The host shutdown installed for this host.
 * @returns Settles when the teardown has finished.
 */
function endInterruptedBoot(shutdown: Pick<HostShutdown, 'cancellation' | 'request' | 'finished'>): Promise<void> {
  return shutdown.cancellation.aborted ? shutdown.finished() : shutdown.request(BOOT_CANCELLED_SHUTDOWN_REASON);
}
