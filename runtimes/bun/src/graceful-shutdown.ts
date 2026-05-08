import type { MakaioRuntime } from '@makaio/runtime-node';
import type { BunServer } from './http-server-utils.js';

/** Options for a Bun composition root shutdown handler. */
export interface BunGracefulShutdownOptions {
  /** Log prefix without brackets, e.g. `server` or `relay`. */
  readonly label: string;
  /** Runtime handle returned by `bootMakaioRuntime`. */
  readonly runtime: Pick<MakaioRuntime, 'shutdown'>;
  /** Bun server owned by the composition root. */
  readonly bunServer: BunServer;
  /** Force-exit timeout in milliseconds. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** Process exit hook, primarily for tests. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
}

/**
 * Create an idempotent signal shutdown handler for Bun composition roots.
 * @param options - Runtime, server, and logging configuration.
 * @returns Signal handler suitable for `process.once`.
 */
export function createGracefulShutdown(options: BunGracefulShutdownOptions): (signal: string) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  let isShuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.info(`[${options.label}] ${signal} received, shutting down...`);

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
