/**
 * Signal-driven shutdown of a Bun host composition root.
 *
 * Wraps the host shutdown coordinator of `@makaio/runtime-node` with what every
 * Bun host needs: the runtime stopped through its lifecycle handle, the Bun
 * server stopped for process exit, and the process ended once the teardown has
 * finished (the listener drain of a Bun server can keep it open otherwise).
 * @packageDocumentation
 */

import {
  BOOT_FAILURE_SHUTDOWN_REASON,
  LOCAL_STEP_STOP_BUDGET_MS,
  hostSignalPolicy,
  installHostShutdown,
  type HangupPolicy,
  type HostShutdown,
  type HostShutdownStep,
  type LifecycleRuntime,
  type RuntimeLifecycle,
} from '@makaio/runtime-node';
import type { BunServer } from './http-server-utils.js';

/** Options for {@link installBunHostShutdown}. */
export interface BunHostShutdownOptions {
  /** Log prefix without brackets, e.g. `server` or `relay`. */
  readonly label: string;
  /**
   * Lifecycle of the runtime the host boots. Boot it through
   * {@link RuntimeLifecycle.boot} (or `bootUnderShutdown`) so a signal that arrives
   * while it boots cancels the boot, and a signal afterwards shuts it down.
   */
  readonly lifecycle: RuntimeLifecycle<LifecycleRuntime>;
  /** Bun server owned by the composition root. */
  readonly bunServer: BunServer;
  /**
   * What the host does on a terminal hangup. Defaults to `'shutdown'`: a Bun host
   * is a daemon that runs under supervisors and containers, where a hangup means
   * its controlling terminal or session ended and nothing is left to serve; and
   * the shutdown is what stops the detached extension children, which run in
   * process groups of their own and receive no terminal signal.
   */
  readonly hangup?: HangupPolicy;
  /**
   * Stages that run after the runtime and the server have stopped, in this order,
   * each inside the window it declares (for example releasing an identity the host
   * registered).
   */
  readonly cleanup?: readonly HostShutdownStep[];
}

/**
 * Install the signal handling of a Bun host: `SIGINT`, `SIGTERM` and (by default)
 * `SIGHUP` shut it down.
 *
 * The listeners are installed before the runtime boots and stay until the teardown
 * has finished, so a signal that arrives during the boot cancels it through the
 * boot's own rollback, and a later signal joins the shutdown in progress instead of
 * ending the host in the middle of it. The runtime's stop runs inside the bound its
 * lifecycle reports; a teardown that fails or runs out of a stage's window ends the
 * process with status 1, and a clean one ends it with status 0.
 * @param options - Runtime lifecycle, server and policy.
 * @returns Control of the installed handling; pass it to `bootUnderShutdown`.
 */
export function installBunHostShutdown(options: BunHostShutdownOptions): HostShutdown {
  // A shutdown that a failed boot requested must not end the process with a clean
  // status: the failure surfaces from the boot instead.
  let endsProcess = false;
  const shutdown = installHostShutdown({
    label: options.label,
    ...hostSignalPolicy(options.hangup),
    steps: [
      options.lifecycle.shutdownStep(),
      {
        name: 'Bun server stop',
        budgetMs: () => LOCAL_STEP_STOP_BUDGET_MS,
        run: () => stopBunServerForProcessExit(options.bunServer, options.label),
      },
      ...(options.cleanup ?? []),
    ],
    onRequest: (reason) => {
      endsProcess = reason !== BOOT_FAILURE_SHUTDOWN_REASON;
    },
  });
  shutdown.cancellation.addEventListener(
    'abort',
    () => {
      if (endsProcess) void shutdown.finished().then(() => process.exit());
    },
    { once: true },
  );
  return shutdown;
}

/**
 * Stop accepting Bun connections without making process exit depend on Bun's
 * listener-drain promise.
 *
 * After the runtime has stopped, application-owned resources are down and the
 * host is about to end the process, so the Bun listener stop is best-effort:
 * prior WebSocket upgrades can leave Bun's returned promise pending even when
 * `stop(true)` was requested.
 * @param bunServer - Bun server owned by the composition root.
 * @param label - Log prefix without brackets.
 */
function stopBunServerForProcessExit(bunServer: BunServer, label: string): void {
  const stopResult = bunServer.stop?.(true);
  if (hasPromiseCatch(stopResult)) {
    void stopResult.catch((error: unknown) => {
      console.warn(`[${label}] Bun server stop failed during shutdown:`, error);
    });
  }
}

/**
 * Check whether a value is a Promise with catch support.
 * @param value - Candidate value.
 * @returns Whether the value exposes a callable `catch`.
 */
function hasPromiseCatch(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' && value !== null && typeof (value as { readonly catch?: unknown }).catch === 'function'
  );
}
