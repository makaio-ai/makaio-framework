import type { IMakaioBus } from '@makaio/bus-core';
import { startMcpServer, type StdioMcpServerHandle } from '@makaio/subsystem-mcp-http-server';

/**
 * Options for the MCP stdio bridge.
 */
export interface McpBridgeOptions {
  /** Session ID to scope tool execution. When omitted, a random UUID is generated. */
  readonly sessionId?: string;
  /** Abort signal to terminate the bridge from outside. When aborted, the bridge closes and resolves. */
  readonly signal?: AbortSignal;
}

/**
 * Check whether stdin has already reached a terminal state.
 * @param stdin - Process stdin stream captured for this bridge instance.
 * @returns `true` when stdin can no longer deliver future input events.
 */
function isStdinTerminated(stdin: NodeJS.ReadStream): boolean {
  return stdin.readableEnded || stdin.closed || stdin.destroyed;
}

/**
 * Start an MCP stdio bridge backed by the Makaio bus.
 *
 * Reads MCP JSON-RPC messages from stdin and dispatches tool calls through the
 * bus. Resolves when stdin ends or closes, or when the bridge is aborted via
 * `opts.signal`.
 *
 * The caller owns the bus lifecycle; this function does not disconnect the bus on exit.
 * @param bus - Connected bus instance owned by the caller.
 * @param opts - Bridge configuration.
 * @returns Promise that resolves when the bridge terminates.
 */
export async function startMcpBridge(bus: IMakaioBus, opts?: McpBridgeOptions): Promise<void> {
  if (opts?.signal?.aborted) return;

  const stdin = process.stdin;
  if (isStdinTerminated(stdin)) return;

  const sessionId = opts?.sessionId ?? crypto.randomUUID();

  // Deferred promise resolved by the onclose seam (stdin EOF or explicit
  // handle.close). Captured before the async gap so it is already set when
  // onclose fires, even if stdin ends during server startup.
  let resolveLifetime!: () => void;
  let rejectLifetime!: (error: unknown) => void;
  const lifetime = new Promise<void>((resolve, reject) => {
    resolveLifetime = resolve;
    rejectLifetime = reject;
  });

  let terminatingViaAbort = false;

  // onclose is called by startMcpServer exactly once when the transport closes
  // for any reason. Stdin EOF uses it as the primary termination seam. Abort
  // shutdown resolves from handle.close() instead, so a close rejection cannot
  // be hidden by the onclose callback that startMcpServer fires from finally().
  const handle: StdioMcpServerHandle = await startMcpServer(bus, sessionId, {
    transport: 'stdio',
    onclose: () => {
      if (terminatingViaAbort) return;
      resolveLifetime();
    },
  });

  // Re-check after the async startMcpServer gap: the signal may have been
  // aborted while the server was starting, and addEventListener('abort')
  // does not fire retroactively for an already-aborted signal. Stdin terminal
  // events are handled inside startMcpServer via the onclose seam; only the
  // abort-signal race requires a post-start check here.
  if (opts?.signal?.aborted || isStdinTerminated(stdin)) {
    await handle.close();
    await lifetime;
    return;
  }

  const onAbort = (): void => {
    if (terminatingViaAbort) return;
    terminatingViaAbort = true;
    opts?.signal?.removeEventListener('abort', onAbort);
    void handle.close().then(resolveLifetime, (error: unknown) => {
      console.error('[MCP Bridge] Error closing server on abort:', error);
      rejectLifetime(error);
    });
  };

  opts?.signal?.addEventListener('abort', onAbort, { once: true });

  // Check abort/stdin state after subscribing so shutdown still runs if
  // abort fired during the async server startup gap.
  if (opts?.signal?.aborted || isStdinTerminated(stdin)) {
    onAbort();
  }

  try {
    await lifetime;
  } finally {
    opts?.signal?.removeEventListener('abort', onAbort);
  }
}
