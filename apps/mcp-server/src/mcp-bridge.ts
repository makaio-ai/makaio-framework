import type { IMakaioBus } from '@makaio/bus-core';
import { startMcpServer, type StdioMcpServerHandle } from '@makaio/mcp-http-server';

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

  const handle: StdioMcpServerHandle = await startMcpServer(bus, sessionId, {
    transport: 'stdio',
  });

  // Re-check after the async startMcpServer gap: the signal may have been
  // aborted while the server was starting, and addEventListener('abort')
  // does not fire retroactively for an already-aborted signal. Stdin terminal
  // events are the same shape: once() listeners cannot observe events that
  // fired while the MCP server was starting.
  if (opts?.signal?.aborted || isStdinTerminated(stdin)) {
    await handle.close();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let terminating = false;
    const onTerminate = (): void => {
      if (terminating) return;
      terminating = true;
      opts?.signal?.removeEventListener('abort', onTerminate);
      stdin.off('end', onTerminate);
      stdin.off('close', onTerminate);
      handle.close().then(resolve, reject);
    };

    opts?.signal?.addEventListener('abort', onTerminate, { once: true });
    stdin.once('end', onTerminate);
    stdin.once('close', onTerminate);

    // EventEmitter once() listeners do not fire for events that happened
    // before registration. Check stream state after subscribing so shutdown
    // still runs if stdin ended during the async server startup gap.
    if (opts?.signal?.aborted || isStdinTerminated(stdin)) {
      onTerminate();
    }
  });
}
