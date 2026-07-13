import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ToolResult } from '@makaio/tools-core';
import { AgentSubjects, ToolSubjects, type ToolExecutionContextOverrides } from '@makaio/contracts';
import { McpContextRegistry, type IMcpContextRegistry } from './context-registry.js';
import {
  APPROVE_TOOL_NAME,
  buildApproveToolDefinition,
  handleApproveToolCall,
  type RequestToolApproval,
  type ToolApproveRequestPayload,
  type ToolApproveResponse,
} from './approve-tool.js';
import {
  resolveMcpTools,
  type McpToolDiscoveryIdentity,
  type McpToolDiscoveryOptions,
  type McpToolEntry,
} from './tool-discovery.js';
import { validateToolExecutionTimeout } from './tool-execution-timeout.js';
import { closeHttpServerSafely, listenForHttpPort } from './http-server-lifecycle.js';
import { connectMcpServerWithCleanup } from './mcp-server-lifecycle.js';
import type {
  CreateMcpServerOptions,
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

/** Query parameter name used by adapters to pass the session ID when custom headers are not available. */
export const ADAPTER_SESSION_ID_PARAM = 'adapterSessionId';

/** HTTP header name that carries the adapter session ID after query-param promotion. */
export const ADAPTER_SESSION_ID_HEADER = 'x-adapter-session-id';

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
   * Gracefully close the MCP server and its transport.
   *
   * Idempotent: repeated calls await the same underlying close operation and
   * do not trigger a second teardown.
   */
  close(): Promise<void>;
}

/**
 * Convert a tool execution result to an MCP call result.
 * @param result - Tool execution result.
 * @returns MCP tool call result.
 */
function toCallToolResult(result: ToolResult<unknown>): CallToolResult {
  if (result.success) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result.error, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Extract the adapter session ID from MCP request headers.
 * @param extra - MCP request handler extra containing optional `requestInfo.headers`
 * @returns The adapter session ID string, or `undefined` when absent.
 */
function extractAdapterSessionId(extra: {
  requestInfo?: { headers: Record<string, string | string[] | undefined> };
}): string | undefined {
  const rawHeader = extra.requestInfo?.headers[ADAPTER_SESSION_ID_HEADER];
  return Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
}

/**
 * Resolve adapter identity from the context registry for a given adapter session.
 * @param adapterSessionId - Adapter session ID extracted from request headers
 * @param contextRegistry - Optional context registry holding per-session agent context
 * @returns Adapter identity for policy enforcement, or `undefined` when unavailable
 */
function resolveAdapterIdentity(
  adapterSessionId: string | undefined,
  contextRegistry: IMcpContextRegistry | undefined,
): McpToolDiscoveryIdentity | undefined {
  if (!adapterSessionId || !contextRegistry) return undefined;
  const agentContext = contextRegistry.get(adapterSessionId);
  if (!agentContext) return undefined;
  return { adapterId: agentContext.adapterId, adapterName: agentContext.adapterName };
}

/**
 * Forward runtime tool registry changes to MCP clients and bind listener cleanup
 * to both direct server closure and connected transport closure.
 * @param server - MCP server instance to notify and close-wrap.
 * @param bus - Bus that emits tool registry lifecycle events.
 */
function bindToolRegistryChangeNotifications(server: Server, bus: IMakaioBus): void {
  const unsubscribeRegistryChanged = bus.on(ToolSubjects.registryChanged, () => {
    void server.sendToolListChanged().catch((error: unknown) => {
      console.error('[MCP Server] Failed to send tools/list_changed notification:', error);
    });
  });

  let registrySubscriptionActive = true;
  const cleanupRegistryChangedSubscription = (): void => {
    if (!registrySubscriptionActive) return;
    registrySubscriptionActive = false;
    unsubscribeRegistryChanged();
  };

  const previousOnClose = server.onclose;
  server.onclose = () => {
    cleanupRegistryChangedSubscription();
    previousOnClose?.();
  };

  const closeServer = server.close.bind(server);
  server.close = async () => {
    try {
      await closeServer();
    } finally {
      // MCP only fires onclose after a connected transport closes. A caller
      // can still abandon a configured server before connecting it, so close()
      // owns this bus subscription cleanup directly as well.
      cleanupRegistryChangedSubscription();
    }
  };
}

/**
 * Merge session-stable tool context overrides with process-level fallbacks.
 * @param sessionOverrides - Session-specific context values resolved from the adapter session ID.
 * @param fallbackSessionId - Process-level session ID used when the registry has no session override.
 * @returns Tool execution context overrides safe to forward to the tool bus.
 */
function buildToolExecutionContextOverrides(
  sessionOverrides: ToolExecutionContextOverrides | undefined,
  fallbackSessionId: string,
): ToolExecutionContextOverrides {
  // Merge session-stable overrides with per-process fallbacks. Explicit
  // undefined fields in sessionOverrides must not overwrite the fallbacks,
  // so we apply ?? for each field individually rather than spreading.
  return {
    cwd: sessionOverrides?.cwd ?? process.cwd(),
    sessionId: sessionOverrides?.sessionId ?? fallbackSessionId,
    env: sessionOverrides?.env,
    agentId: sessionOverrides?.agentId,
    adapterSessionId: sessionOverrides?.adapterSessionId,
    turnId: sessionOverrides?.turnId,
    reasoning: sessionOverrides?.reasoning,
    toolCallId: sessionOverrides?.toolCallId,
    turnContext: sessionOverrides?.turnContext,
    constraints: sessionOverrides?.constraints,
  };
}

/**
 * Create and configure MCP server.
 *
 * **Freshness contract:** Tool lists are resolved fresh on every MCP `tools/list` and
 * `tools/call` request. There is no caching between calls.
 * @param bus - Bus instance for tool execution and approval RPC.
 * @param sessionId - Session identifier for tool execution context.
 * @param options - Optional server configuration.
 * @returns Configured MCP {@link Server} instance.
 */
export async function createMcpServer(bus: IMakaioBus, sessionId: string, options?: CreateMcpServerOptions) {
  const { contextRegistry, toolDiscovery, resolveContextOverrides } = options ?? {};
  const toolExecutionTimeoutMs = validateToolExecutionTimeout(options?.toolExecutionTimeoutMs);
  const server = new Server({ name: 'makaio', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const requestToolApproval: RequestToolApproval = (payload) => bus.request(AgentSubjects.toolApprove, payload);

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const listSessionId = extractAdapterSessionId(extra);
    const identity = resolveAdapterIdentity(listSessionId, contextRegistry);

    const resolved = await resolveMcpTools(bus, toolDiscovery, identity);
    return {
      tools: [...resolved.tools, ...(contextRegistry ? [buildApproveToolDefinition()] : [])],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const adapterSessionId = extractAdapterSessionId(extra);

    if (request.params.name === APPROVE_TOOL_NAME) {
      if (!contextRegistry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                behavior: 'deny',
                message: 'Permission prompt tool is not available in this server mode',
              }),
            },
          ],
        };
      }

      return handleApproveToolCall(request.params.arguments, contextRegistry, adapterSessionId, requestToolApproval);
    }

    const callIdentity = resolveAdapterIdentity(adapterSessionId, contextRegistry);

    const resolved = await resolveMcpTools(bus, toolDiscovery, callIdentity);
    const requestedTool = resolved.byMcpName.get(request.params.name);
    if (!requestedTool) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }

    // Unknown sessions use process defaults so standalone MCP servers remain usable.
    const sessionOverrides = resolveContextOverrides?.(adapterSessionId);
    const contextOverrides = buildToolExecutionContextOverrides(sessionOverrides, sessionId);

    const executePayload = {
      toolName: requestedTool.sourceToolName,
      input: request.params.arguments ?? {},
      adapterId: callIdentity?.adapterId,
      adapterName: callIdentity?.adapterName,
      contextOverrides,
    };
    const execution =
      toolExecutionTimeoutMs === undefined
        ? await bus.requestOptional(ToolSubjects.execute, executePayload)
        : await bus.requestOptional(ToolSubjects.execute, executePayload, { timeout: toolExecutionTimeoutMs });
    if (!execution.handled) {
      throw new McpError(ErrorCode.InternalError, 'Tool execution handler unavailable');
    }

    return toCallToolResult(execution.data as ToolResult<unknown>);
  });

  bindToolRegistryChangeNotifications(server, bus);

  return server;
}

/**
 * Create a framework-agnostic HTTP request handler that delegates to
 * {@link StreamableHTTPServerTransport.handleRequest}.
 *
 * **External consumers should prefer {@link createHttpMcpHandler}**, which
 * constructs the transport internally so no MCP SDK type needs to appear in
 * caller code.  This lower-level function is exposed for internal composition
 * and testing.
 *
 * The transport handles body parsing internally; do not pre-parse the body
 * before calling this handler, as that would consume the request stream before
 * MCP can read it.
 * @param transport - Streamable HTTP transport instance connected to the server.
 * @param onBeforeDispatch - Optional hook called synchronously before request dispatch.
 * @returns Node.js-compatible request handler.
 */
export function createMcpRequestHandler(
  transport: StreamableHTTPServerTransport,
  onBeforeDispatch?: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse) => {
    onBeforeDispatch?.(req, res);
    void transport.handleRequest(req, res).catch((error) => {
      console.error('[MCP Server] Failed to handle request:', error);
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    });
  };
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
 * The MCP SDK transport is constructed and managed internally — no MCP SDK
 * types appear in the public API.
 *
 * **Auth / middleware is the consumer's responsibility.** Run authentication,
 * rate limiting, or logging in the surrounding HTTP stack *before* delegating
 * to the returned handler.
 *
 * Closing the handle shuts down the MCP server and its transport; active
 * HTTP connections are left to the caller's HTTP stack.
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
  const contextRegistry = new McpContextRegistry();

  const sessionId = options.agentContext?.adapterSessionId ?? crypto.randomUUID();
  if (options.agentContext) {
    contextRegistry.register(sessionId, options.agentContext);
  }

  const mcpServer = await createMcpServer(bus, sessionId, {
    contextRegistry,
    toolDiscovery: options.toolDiscovery,
    resolveContextOverrides: options.resolveContextOverrides,
    toolExecutionTimeoutMs: options.toolExecutionTimeoutMs,
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  if (options.onclose) {
    transport.onclose = options.onclose;
  }
  await connectMcpServerWithCleanup(mcpServer, transport, () => mcpServer.close(), 'HTTP MCP handler');

  // adapterSessionId query-param → x-adapter-session-id header shim.
  // This is a protocol contract (not a listener detail): adapters pass the
  // session ID as a query param because some HTTP clients cannot set custom
  // headers on SSE GET requests.
  const handler = createMcpRequestHandler(transport, (req) => {
    const rawUrl = req.url ?? '/';
    const queryStart = rawUrl.indexOf('?');
    if (queryStart === -1) return;

    const adapterSessionId = new URLSearchParams(rawUrl.slice(queryStart + 1)).get(ADAPTER_SESSION_ID_PARAM);
    if (adapterSessionId) {
      req.headers[ADAPTER_SESSION_ID_HEADER] = adapterSessionId;
      Object.defineProperty(req, 'rawHeaders', {
        value: [...req.rawHeaders, ADAPTER_SESSION_ID_HEADER, adapterSessionId],
        configurable: true,
      });
    }
  });

  // Idempotent close: all callers await the same promise so the underlying
  // MCP server teardown is never duplicated (mirrors the stdio closeOnce pattern).
  let closePromise: Promise<void> | undefined;

  return {
    handler,
    contextRegistry,
    close(): Promise<void> {
      if (!closePromise) {
        closePromise = mcpServer.close();
      }
      return closePromise;
    },
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

  let closePromise: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    closePromise ??= (async () => {
      // Force-close keep-alive connections before waiting for server drain.
      httpServer.closeAllConnections();
      const results = await Promise.allSettled([handle.close(), closeHttpServerSafely(httpServer)]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to close HTTP MCP server resources');
      }
    })();
    return closePromise;
  };

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
 * `options.onclose` to receive a single callback when the transport closes for
 * any reason (client detach via stdin EOF, or explicit `handle.close()`). Pass
 * `options.resolveContextOverrides` to resolve current execution context on
 * every tool call, including calls after client reconnects.
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

  // Stdin EOF and explicit close share one teardown promise.
  let closePromise: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    if (!closePromise) {
      stdin.off('end', onStdinEnd);
      stdin.off('close', onStdinEnd);
      // `finally` guarantees the caller's onclose even when teardown fails
      // before the transport's own onclose hook runs (rejected server.close()).
      closePromise = server.close().finally(fireOnce);
    }
    return closePromise;
  };

  // Guard ensuring `onclose` fires at most once regardless of which event
  // (stdin EOF or explicit handle.close) triggers the close.
  let onceFired = false;
  const fireOnce = (): void => {
    if (onceFired) return;
    onceFired = true;
    options.onclose?.();
  };

  // Detect client detach: stdin reaching EOF without an explicit close().
  // Initiates server shutdown so the transport fires its own onclose hook
  // which then delivers fireOnce. Do not call fireOnce directly here so
  // teardown always runs before notifying the caller.
  const onStdinEnd = (): void => {
    void closeOnce().catch((error: unknown) => {
      console.error('[MCP Server] Error closing server on stdin EOF:', error);
    });
  };

  // Mirror the HTTP path: wire the transport's own onclose hook so that
  // server.close() cascades into the caller's onclose callback and cleans
  // up the stdin listeners in one place.
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
