import type { HttpMcpServerHandle } from '@makaio/mcp-http-server';

/**
 * Worker-scoped lifecycle for the shared MCP HTTP test server.
 *
 * The test harness intentionally keeps one server alive for the whole Vitest
 * worker, but failed starts must not poison later retries and async shutdown
 * must happen from the test lifecycle rather than `process.on('exit')`.
 */
export interface McpTestServerLifecycle {
  /** Start the shared server if needed, coalescing concurrent callers. */
  ensureStarted(): Promise<HttpMcpServerHandle>;
  /** Read the current handle without triggering startup. */
  getHandle(): HttpMcpServerHandle | null;
  /** Close the running server or abort an in-flight start, then reset to stopped. */
  close(): Promise<void>;
}

/**
 * Create a retryable lifecycle controller for the shared MCP HTTP test server.
 * @param startServer - Factory that starts the HTTP server
 * @returns Controller that tracks stopped/starting/running states
 */
export function createMcpTestServerLifecycle(startServer: () => Promise<HttpMcpServerHandle>): McpTestServerLifecycle {
  let handle: HttpMcpServerHandle | null = null;
  let startPromise: Promise<HttpMcpServerHandle> | null = null;
  // Teardown bumps the lifecycle generation so late start completions can
  // identify themselves as stale and close immediately instead of rearming the
  // worker-scoped server after `close()` won the race.
  let generation = 0;

  return {
    async ensureStarted(): Promise<HttpMcpServerHandle> {
      if (handle) {
        return handle;
      }
      if (startPromise) {
        return startPromise;
      }

      const startGeneration = generation;
      const pendingStart = startServer().then(async (startedHandle) => {
        if (generation !== startGeneration) {
          await startedHandle.close();
          throw new Error('MCP test server lifecycle was closed during startup');
        }

        handle = startedHandle;
        return startedHandle;
      });

      const trackedStart = pendingStart.finally(() => {
        if (startPromise === trackedStart) {
          // Failed starts must return to the stopped state so later session
          // registrations can retry instead of reusing a rejected promise.
          startPromise = null;
        }
      });
      startPromise = trackedStart;

      return trackedStart;
    },

    getHandle(): HttpMcpServerHandle | null {
      return handle;
    },

    async close(): Promise<void> {
      const currentHandle = handle;
      const pendingStart = startPromise;
      generation += 1;
      handle = null;
      startPromise = null;
      if (currentHandle) {
        await currentHandle.close();
      }
      if (pendingStart) {
        await pendingStart.catch(() => undefined);
      }
    },
  };
}
