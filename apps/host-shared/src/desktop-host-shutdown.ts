/**
 * Signal handling and teardown ordering shared by the desktop hosts.
 *
 * Both desktop hosts run the same teardown around the same runtime and stop on
 * the same signals; only what triggers a quit (Electron's `before-quit`, the
 * Electrobun tray and window lifecycle) and how the process ends differ. This
 * module owns what is common: the signals, the boot window, the stop bound and
 * the cancellation of a boot a quit interrupts. The host owns its triggers and
 * hands in how to end the process.
 * @packageDocumentation
 */

import {
  hostSignalPolicy,
  installHostShutdown,
  type HostShutdown,
  type HostShutdownStep,
  type LifecycleRuntime,
  type RuntimeLifecycle,
} from '@makaio/runtime-node';

/** Options for {@link installDesktopHostShutdown}. */
export interface DesktopHostShutdownOptions {
  /** Log prefix without brackets, e.g. `electron`. */
  readonly label: string;
  /**
   * Lifecycle of the runtime the host boots. Boot it through
   * {@link RuntimeLifecycle.boot} so a quit that arrives while it boots cancels
   * the boot through its own rollback.
   */
  readonly lifecycle: RuntimeLifecycle<LifecycleRuntime>;
  /** Stages that run before the runtime stops (for example saving the window session), in this order. */
  readonly beforeRuntime?: readonly HostShutdownStep[];
  /** Stages that run after the runtime has stopped (for example the tray and the server), in this order. */
  readonly afterRuntime?: readonly HostShutdownStep[];
  /**
   * End the host process. Called once the teardown has finished cleanly, for a
   * quit from any source; a teardown that failed or ran out of a stage's window
   * ends the process with status 1 itself.
   */
  readonly exit: () => void;
}

/**
 * Install the shutdown of a desktop host.
 *
 * `SIGINT`, `SIGTERM` and `SIGHUP` shut the host down. Desktop hosts have no
 * `ignore-hangup` option: they normally run without a controlling terminal, so
 * a hangup only reaches one that was launched from a terminal (a development
 * run), and there it means the session that owns the host has ended. Taking the
 * default action instead would end the host without stopping the detached
 * extension children, which run in process groups of their own and receive no
 * terminal signal.
 *
 * The listeners are installed at the call, so call it before the runtime boots;
 * they stay until the teardown has finished, and a later signal or quit joins the
 * shutdown in progress. A host-specific trigger requests the shutdown through the
 * returned control.
 * @param options - Runtime lifecycle, teardown stages and how to end the process.
 * @returns Control of the installed handling; `request()` is what a host trigger calls.
 */
export function installDesktopHostShutdown(options: DesktopHostShutdownOptions): HostShutdown {
  const shutdown = installHostShutdown({
    label: options.label,
    ...hostSignalPolicy('shutdown'),
    steps: [...(options.beforeRuntime ?? []), options.lifecycle.shutdownStep(), ...(options.afterRuntime ?? [])],
  });
  shutdown.cancellation.addEventListener('abort', () => void shutdown.finished().then(options.exit), { once: true });
  return shutdown;
}

/**
 * Create the teardown stage that runs a set of cleanups, each of which gets its
 * turn whether the ones before it failed or not.
 * @param name - Name the report of a stage that did not finish uses.
 * @param budgetMs - Window of the stage, in milliseconds.
 * @param cleanups - Reads the cleanups when the stage runs, so ones registered after the host installed its shutdown are included.
 * @returns The stage; it rejects with an `AggregateError` of every failed cleanup once all have run.
 */
export function cleanupsStep(
  name: string,
  budgetMs: () => number,
  cleanups: () => readonly (() => void | Promise<void>)[],
): HostShutdownStep {
  return {
    name,
    budgetMs,
    run: async () => {
      const failures: unknown[] = [];
      for (const cleanup of cleanups()) {
        try {
          await cleanup();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} of the "${name}" cleanups failed`);
      }
    },
  };
}
