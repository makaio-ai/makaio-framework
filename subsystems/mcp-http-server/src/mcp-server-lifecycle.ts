import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Wrap an optional notification so it is delivered at most once.
 *
 * Every close path in this subsystem has more than one trigger — stdin EOF or
 * an explicit `close()`, endpoint shutdown or a rejected teardown — and each
 * must converge on a single caller-visible notification.
 * @param notify - Callback to deliver once, if provided.
 * @returns A callback that forwards the first invocation and ignores the rest.
 */
export function once(notify: (() => void) | undefined): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    notify?.();
  };
}

/**
 * Wrap a teardown so every caller awaits the same single execution.
 *
 * Teardown is not idempotent by itself: running it twice would close sessions
 * that a concurrent caller is still draining. Memoizing the promise — rather
 * than a boolean — is what makes a second `close()` *wait for* the first
 * instead of returning while it is still running.
 * @param teardown - Teardown to run at most once.
 * @returns A close function returning the shared teardown promise.
 */
export function onceAsync(teardown: () => Promise<void>): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => (closePromise ??= teardown());
}

/**
 * Connect an MCP server and tear down all server-owned resources if startup fails.
 * @param server - MCP server to connect.
 * @param transport - Transport to attach to the server.
 * @param close - Idempotent teardown that owns transport-specific cleanup.
 * @param resourceName - Human-readable resource name used in startup errors.
 */
export async function connectMcpServerWithCleanup(
  server: Server,
  transport: Transport,
  close: () => Promise<void>,
  resourceName: string,
): Promise<void> {
  try {
    await server.connect(transport);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to start and clean up ${resourceName}`);
    }
    throw error;
  }
}

/**
 * Run independent teardowns to completion and surface every failure at once.
 *
 * Teardown steps must not short-circuit each other: a failing MCP session close
 * may not prevent the HTTP socket drain, and vice versa. Callers therefore get
 * all failures aggregated rather than only the first one.
 * @param teardowns - Independent teardown operations, already started.
 * @param message - Message for the {@link AggregateError} raised on failure.
 */
export async function settleAllTeardowns(teardowns: Array<Promise<unknown>>, message: string): Promise<void> {
  const results = await Promise.allSettled(teardowns);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}
