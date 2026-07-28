import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IMakaioBus } from '@makaio/bus-core';
import type { IMcpContextRegistry } from './context-registry.js';
import {
  handleApproveToolCall,
  type RequestToolApproval,
  type ToolApproveRequestPayload,
  type ToolApproveResponse,
} from './approve-tool.js';
import type { McpToolDiscoveryIdentity, McpToolDiscoveryOptions, McpToolEntry } from './tool-discovery.js';
import { ADAPTER_SESSION_ID_HEADER, ADAPTER_SESSION_ID_PARAM, createMcpServer } from './create-mcp-server.js';
import { closeHttpServerSafely, listenForHttpPort } from './http-server-lifecycle.js';
import { connectMcpServerWithCleanup, once, onceAsync, settleAllTeardowns } from './mcp-server-lifecycle.js';
import { MCP_INTERNAL_ERROR, mcpRouteFailureError, writeMcpHttpError } from './mcp-http-errors.js';
import { createMcpEndpoint } from './mcp-endpoint.js';
import type {
  HttpMcpHandlerOptions,
  HttpMcpServerHandle,
  HttpMcpServerOptions,
  McpServerOptions,
  StdioMcpServerHandle,
} from './server-options.js';
export type {
  CreateMcpServerOptions,
  HttpMcpHandlerOptions,
  HttpMcpServerHandle,
  HttpMcpServerOptions,
  McpServerOptions,
  ResolveContextOverrides,
  StdioMcpServerHandle,
} from './server-options.js';

export { handleApproveToolCall };
export type {
  McpToolDiscoveryIdentity,
  McpToolEntry,
  McpToolDiscoveryOptions,
  RequestToolApproval,
  ToolApproveRequestPayload,
  ToolApproveResponse,
};

/**
 * Result returned by {@link createHttpMcpHandler}.
 *
 * Provides a Node.js-compatible request handler that can be mounted on any
 * HTTP stack that exposes the raw `IncomingMessage` / `ServerResponse` pair,
 * plus lifecycle handles for the underlying MCP server. See
 * {@link createHttpMcpHandler} for usage and mounting examples.
 */
export interface HttpMcpHandlerHandle {
  /**
   * Mount this on any Node-compatible HTTP stack.
   *
   * The handler parses the raw request body internally; do not pre-read or
   * pre-parse the body before passing the request to this function.
   */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Context registry for registering and unregistering agent sessions. */
  readonly contextRegistry: IMcpContextRegistry;
  /**
   * Gracefully close the endpoint and every MCP client session it owns.
   *
   * Idempotent: repeated calls await the same underlying close operation and
   * do not trigger a second teardown.
   */
  close(): Promise<void>;
}

/**
 * Promote the `adapterSessionId` query parameter to an `x-adapter-session-id`
 * header on a Node request.
 *
 * This is a protocol contract, not a listener detail: adapters pass the session
 * ID as a query param because some HTTP clients cannot set custom headers on
 * SSE GET requests. It must run on every request, before routing, because the
 * MCP request handlers read the header per request.
 * @param req - Incoming request, mutated in place.
 */
function applyAdapterSessionIdShim(req: IncomingMessage): void {
  const rawUrl = req.url ?? '/';
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return;

  const adapterSessionId = new URLSearchParams(rawUrl.slice(queryStart + 1)).get(ADAPTER_SESSION_ID_PARAM);
  if (!adapterSessionId) return;

  req.headers[ADAPTER_SESSION_ID_HEADER] = adapterSessionId;
  Object.defineProperty(req, 'rawHeaders', {
    value: [...req.rawHeaders, ADAPTER_SESSION_ID_HEADER, adapterSessionId],
    configurable: true,
  });
}

/**
 * Read the MCP protocol session ID that identifies the client's transport.
 * @param req - Incoming request.
 * @returns The `Mcp-Session-Id` header value, or `undefined` when absent.
 */
function readMcpSessionId(req: IncomingMessage): string | undefined {
  const raw = req.headers['mcp-session-id'];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Create a mountable MCP handler without starting a dedicated HTTP server.
 *
 * Use this when you want to embed MCP into an existing HTTP application rather
 * than running MCP on its own port.  The returned {@link HttpMcpHandlerHandle.handler}
 * is a plain Node.js `(req, res) => void` function that you can wire into any
 * framework exposing the raw `IncomingMessage` / `ServerResponse` pair (e.g.
 * Hono's Node adapter via `(c) => { handler(c.env.incoming, c.env.outgoing); }`).
 *
 * The endpoint serves **many concurrent MCP clients**. Each client gets its own
 * `(transport, server)` pair keyed by the MCP protocol session ID; see
 * {@link McpTransportRegistry} for the full lifecycle contract. This is
 * independent of the adapter session carried by the `adapterSessionId` query
 * param, of which many may share a single MCP client.
 *
 * The MCP SDK transport is constructed and managed internally — no MCP SDK
 * types appear in the public API.
 *
 * **Auth / middleware is the consumer's responsibility.** Run authentication,
 * rate limiting, or logging in the surrounding HTTP stack *before* delegating
 * to the returned handler.
 *
 * Closing the handle shuts down every live MCP client session; active HTTP
 * connections are left to the caller's HTTP stack.
 * @param bus - Bus instance for tool execution and approval RPC.
 * @param options - Handler options; all fields are optional.
 * @returns Handle with the request handler function, context registry, and
 *   an idempotent `close()` method.
 * @example
 * ```ts
 * import * as http from 'node:http';
 * import { createHttpMcpHandler } from '@makaio/subsystem-mcp-http-server';
 *
 * const { handler, close } = await createHttpMcpHandler(bus);
 *
 * const httpServer = http.createServer((req, res) => {
 *   if (req.url?.startsWith('/mcp')) {
 *     handler(req, res);
 *   } else {
 *     res.writeHead(404).end();
 *   }
 * });
 *
 * httpServer.listen(3000);
 *
 * process.once('SIGTERM', async () => {
 *   httpServer.close();
 *   await close();
 * });
 * ```
 */
export async function createHttpMcpHandler(
  bus: IMakaioBus,
  options: HttpMcpHandlerOptions = {},
): Promise<HttpMcpHandlerHandle> {
  const endpoint = createMcpEndpoint<StreamableHTTPServerTransport>(
    bus,
    options,
    (hooks) =>
      new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (mcpSessionId) => hooks.onSessionInitialized(mcpSessionId),
      }),
  );

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const route = await endpoint.registry.route({
      method: req.method ?? 'GET',
      mcpSessionId: readMcpSessionId(req),
    });
    if (route.outcome !== 'dispatch') {
      writeMcpHttpError(res, mcpRouteFailureError(route.outcome));
      return;
    }

    // The activity lease is held until the response completes, so a client
    // holding its standalone SSE stream never looks idle to the reaper.
    res.once('close', route.finish);

    // Opening a session is asynchronous, so the client may have hung up while
    // `route()` was still in flight. `close` has then already been emitted and
    // the one-shot listener above will never run, which would pin the lease at
    // one open exchange forever and make the session permanently unreapable.
    // `res.closed` is exactly "the close event already fired", and `finish()`
    // is idempotent, so releasing here is safe in either ordering.
    if (res.closed) {
      route.finish();
      return;
    }

    await route.transport.handleRequest(req, res);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    applyAdapterSessionIdShim(req);
    void dispatch(req, res).catch((error: unknown) => {
      console.error('[MCP Server] Failed to handle request:', error);
      if (!res.headersSent && !res.writableEnded) {
        writeMcpHttpError(res, MCP_INTERNAL_ERROR);
      }
    });
  };

  return {
    handler,
    contextRegistry: endpoint.contextRegistry,
    close: endpoint.close,
  };
}

/**
 * Start a standalone HTTP MCP server on a new `http.Server`.
 *
 * This is a convenience wrapper around {@link createHttpMcpHandler} that also
 * creates an `http.Server`, binds it to a TCP port, and manages connection
 * draining on close.  Use {@link createHttpMcpHandler} directly when you need
 * to embed MCP into an existing HTTP application.
 * @param bus - Bus instance.
 * @param options - Server options; `port` defaults to 0 (OS-assigned).
 *   Pass `resolveContextOverrides` to supply session-stable context overrides
 *   at tool-call time (used by {@link McpServerBridgeService}).
 * @returns Handle exposing the OS-assigned port, context registry, and a close function.
 */
export async function startHttpMcpServer(
  bus: IMakaioBus,
  options: HttpMcpServerOptions = {},
): Promise<HttpMcpServerHandle> {
  const handle = await createHttpMcpHandler(bus, options);

  const httpServer = http.createServer(handle.handler);

  const port = await listenForHttpPort(httpServer, options.port ?? 0, async () => {
    await Promise.allSettled([handle.close(), closeHttpServerSafely(httpServer)]);
  });

  console.error(`[MCP Server] HTTP transport listening on port ${port}`);

  const closeOnce = onceAsync(async () => {
    // Force-close keep-alive connections before waiting for server drain.
    httpServer.closeAllConnections();
    await settleAllTeardowns(
      [handle.close(), closeHttpServerSafely(httpServer)],
      'Failed to close HTTP MCP server resources',
    );
  });

  return {
    port,
    contextRegistry: handle.contextRegistry,
    close: closeOnce,
  };
}

/**
 * Start MCP server with the configured transport.
 *
 * For the stdio transport, returns a {@link StdioMcpServerHandle} whose
 * `close()` method gracefully tears down the MCP server. Pass
 * `options.onclose` to receive a single callback when the server stops serving:
 * for stdio that is client detach via stdin EOF or an explicit `handle.close()`;
 * for HTTP it is endpoint shutdown only, never an individual MCP client
 * disconnecting. Pass `options.resolveContextOverrides` to resolve current
 * execution context on every tool call, including calls after client reconnects.
 * Signal handling is intentionally left to the composition root — library code
 * must not own process-global resources such as `process.on('SIGINT')`.
 * @param bus - Bus instance.
 * @param sessionId - Session identifier (used for stdio transport).
 * @param options - Server options; defaults to stdio transport.
 * @returns A handle exposing a `close()` function for both transports.
 *   For HTTP transport the handle additionally exposes the OS-assigned
 *   port and the context registry.
 */
export async function startMcpServer(
  bus: IMakaioBus,
  sessionId: string,
  options: McpServerOptions = { transport: 'stdio' },
): Promise<HttpMcpServerHandle | StdioMcpServerHandle> {
  if (options.transport === 'http') {
    return startHttpMcpServer(bus, options);
  }

  const server = await createMcpServer(bus, sessionId, {
    toolDiscovery: options.toolDiscovery,
    resolveContextOverrides: options.resolveContextOverrides,
    toolExecutionTimeoutMs: options.toolExecutionTimeoutMs,
  });
  const transport = new StdioServerTransport();

  const stdin = process.stdin;

  // stdio has two independent close triggers — stdin EOF and an explicit
  // handle.close() — and the transport's own onclose is a third path to the
  // caller's notification, so the guard must be on the notification, not on the
  // teardown that happens to precede it.
  const fireOnce = once(options.onclose);

  // Stdin EOF and explicit close share one teardown promise. Detaching the
  // stdin listeners is part of that teardown, and runs synchronously on the
  // first call because `onceAsync` invokes the teardown eagerly.
  const closeOnce = onceAsync(async () => {
    stdin.off('end', onStdinEnd);
    stdin.off('close', onStdinEnd);
    // `finally` guarantees the caller's onclose even when teardown fails
    // before the transport's own onclose hook runs (rejected server.close()).
    await server.close().finally(fireOnce);
  });

  // Detect client detach: stdin reaching EOF without an explicit close().
  // Initiates server shutdown so the transport fires its own onclose hook
  // which then delivers fireOnce. Do not call fireOnce directly here so
  // teardown always runs before notifying the caller.
  const onStdinEnd = (): void => {
    void closeOnce().catch((error: unknown) => {
      console.error('[MCP Server] Error closing server on stdin EOF:', error);
    });
  };

  // stdio is inherently single-client, so the transport closing *is* the server
  // no longer serving. Wiring the caller's onclose here is therefore correct on
  // this path, unlike on HTTP where one client's transport closing says nothing
  // about the endpoint. It also cleans up the stdin listeners in one place.
  transport.onclose = (): void => {
    // closeOnce already removed the stdin listeners; remove again as a
    // safety net for any future code path that calls transport.close() directly.
    stdin.off('end', onStdinEnd);
    stdin.off('close', onStdinEnd);
    fireOnce();
  };

  // Attach stdin EOF listeners after wiring transport.onclose so that any
  // EOF arriving during or after connect() is routed through closeOnce().
  stdin.once('end', onStdinEnd);
  stdin.once('close', onStdinEnd);

  await connectMcpServerWithCleanup(server, transport, closeOnce, 'stdio MCP server');

  console.error('[MCP Server] Started and listening on stdio');

  return {
    close: async () => {
      await closeOnce();
    },
  };
}
