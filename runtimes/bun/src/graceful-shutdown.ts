import type { MakaioRuntime } from '@makaio/runtime-node';
import { outerBoundMs } from '@makaio/utils';
import type { BunServer } from './http-server-utils.js';

/** Options for a Bun composition root shutdown handler. */
export interface BunGracefulShutdownOptions {
  /** Log prefix without brackets, e.g. `server` or `relay`. */
  readonly label: string;
  /** Runtime handle returned by `bootMakaioRuntime`. */
  readonly runtime: Pick<MakaioRuntime, 'shutdown' | 'stopBudgetMs'>;
  /** Bun server owned by the composition root. */
  readonly bunServer: BunServer;
  /**
   * Force-exit timeout in milliseconds. Defaults to the runtime's own bound,
   * `runtime.stopBudgetMs()` plus the headroom of an outer bound
   * (`outerBoundMs`), read when the shutdown starts: the runtime bounds each
   * of its stops itself, so this timer is a backstop, never the thing that
   * limits a stop within the runtime's contract. An override below that bound
   * can end the process while a cleanup is still within its declared window.
   */
  readonly timeoutMs?: number;
  /** Process exit hook, primarily for tests. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
}

/**
 * Create an idempotent signal shutdown handler for Bun composition roots.
 *
 * TODO(FACT-464): Bun hosts still lack persistent signal handlers (a second
 * signal during the shutdown takes the default action), cancellation of a boot
 * in flight, and `SIGHUP` handling; `makaio serve` has them through
 * `installHostShutdown`.
 * @param options - Runtime, server, and logging configuration.
 * @returns Signal handler suitable for `process.once`.
 */
export function createGracefulShutdown(options: BunGracefulShutdownOptions): (signal: string) => Promise<void> {
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  let isShuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.info(`[${options.label}] ${signal} received, shutting down...`);

    // Read now, not when the handler is created: the runtime's bound is the sum
    // over the extensions that actually started.
    const timeoutMs = options.timeoutMs ?? outerBoundMs(options.runtime.stopBudgetMs());
    // Keep this timer ref'ed while shutdown is in progress. It is the ownership
    // guard that turns a hung runtime shutdown into a deterministic non-zero exit.
    const forceExit = setTimeout(() => {
      console.error(`[${options.label}] Graceful shutdown timed out, forcing exit`);
      exit(1);
    }, timeoutMs);

    try {
      if (process.env['MAKAIO_DEBUG']) {
        console.info(`[${options.label}] Shutting down runtime...`);
      }
      await options.runtime.shutdown();
      if (process.env['MAKAIO_DEBUG']) {
        console.info(`[${options.label}] Stopping Bun server...`);
      }
      stopBunServerForProcessExit(options.bunServer, options.label);
      if (process.env['MAKAIO_DEBUG']) {
        console.info(`[${options.label}] Shutdown complete`);
      }
      clearTimeout(forceExit);
      exit(0);
    } catch (error: unknown) {
      stopBunServerForProcessExit(options.bunServer, options.label);
      clearTimeout(forceExit);
      console.error(`[${options.label}] Shutdown error:`, error);
      exit(1);
    }
  };
}

/**
 * Stop accepting Bun connections without making process exit depend on Bun's
 * listener-drain promise.
 *
 * After `runtime.shutdown()` completes, application-owned resources are down.
 * The composition root is about to call `process.exit()`, so the Bun listener
 * stop is best-effort: prior WebSocket upgrades can leave Bun's returned
 * promise pending even when `stop(true)` was requested.
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
