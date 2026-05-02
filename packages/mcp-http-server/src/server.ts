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
import {
  AgentSubjects,
  ToolSubjects,
  type McpAgentContext,
  type ToolExecutionContextOverrides,
} from '@makaio/contracts';
import { McpContextRegistry, type IMcpContextRegistry } from './context-registry.js';
import {
  APPROVE_TOOL_NAME,
  buildApproveToolDefinition,
  handleApproveToolCall,
  type RequestToolApproval,
  type ToolApproveRequestPayload,
  type ToolApproveResponse,
} from './approve-tool.js';
import { resolveMcpTools, type McpToolDiscoveryOptions, type McpToolEntry } from './tool-discovery.js';

export { handleApproveToolCall };
export type {
  McpToolEntry,
  McpToolDiscoveryOptions,
  RequestToolApproval,
  ToolApproveRequestPayload,
  ToolApproveResponse,
};

/**
 * Options for configuring MCP server startup.
 */
export interface McpServerOptions {
  /** Required. Defaults to `'stdio'` when using {@link startMcpServer}. */
  transport: 'stdio' | 'http';
  /** Port for HTTP transport. When omitted or 0, OS assigns an available port. */
  port?: number;
  /** Agent context for HTTP transport routing. */
  agentContext?: McpAgentContext;
  /** Optional MCP tool discovery customization. */
  toolDiscovery?: McpToolDiscoveryOptions;
}

/**
 * Result returned by {@link startMcpServer} for the stdio transport.
 */
export interface StdioMcpServerHandle {
  /** Gracefully close the MCP server and stdio transport. */
  close: () => Promise<void>;
}

/**
 * Result returned by {@link startHttpMcpServer}.
 */
export interface HttpMcpServerHandle {
  /** OS-assigned port the HTTP server is listening on. */
  port: number;
  /** Context registry for registering/unregistering agent sessions. */
  contextRegistry: IMcpContextRegistry;
  /** Gracefully close the HTTP server and MCP transport. */
  close: () => Promise<void>;
}

/**
 * Callback that resolves session-stable context overrides for a given
 * adapter session ID.
 *
 * Invoked on every tool-call request. When the session is found, its
 * return value overrides the default fallback context
 * `{ cwd: process.cwd(), sessionId }`. When the session is unknown or
 * the header is absent, returning `undefined` keeps the fallback.
 * @param adapterSessionId - The adapter session ID extracted from request
 *   headers, or `undefined` when the header is absent.
 * @returns Resolved context overrides, or `undefined` to use the fallback.
 */
export type ResolveContextOverrides = (
  adapterSessionId: string | undefined,
) => ToolExecutionContextOverrides | undefined;

/**
 * Options for {@link createMcpServer}.
 */
export interface CreateMcpServerOptions {
  /** Registry for resolving agent context by adapterSessionId. When present, the `approve` tool is exposed. */
  contextRegistry?: IMcpContextRegistry;
  /** Optional tool discovery customization. */
  toolDiscovery?: McpToolDiscoveryOptions;
  /** Optional callback to resolve session-stable context overrides from an adapter session ID at tool-call time. */
  resolveContextOverrides?: ResolveContextOverrides;
}

/**
 * Options accepted by {@link startHttpMcpServer}.
 *
 * Extends the transport-agnostic {@link McpServerOptions} fields (minus
 * `transport`, which is always `'http'` for this function) with an optional
 * callback for resolving session-stable context overrides at tool-call time.
 */
export interface HttpMcpServerOptions extends Omit<McpServerOptions, 'transport'> {
  /** Optional callback for session-stable context override resolution. */
  resolveContextOverrides?: ResolveContextOverrides;
  /**
   * Optional callback invoked when the HTTP transport closes.
   *
   * Called synchronously by the MCP SDK's transport `onclose` hook — that is,
   * when {@link HttpMcpServerHandle.close} has been called and the transport
   * has finished closing. Intended for best-effort resource cleanup (e.g.
   * flushing session registries) without blocking the close path.
   */
  onclose?: () => void;
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
 * Create and configure MCP server.
 *
 * **Freshness contract:** Tool lists are resolved fresh on every MCP `tools/list` and
 * `tools/call` request. There is no caching between calls.
 *
 * **Side-effect:** Subscribes to {@link ToolSubjects.registryChanged} on `bus` and
 * sends `notifications/tools/list_changed` to connected MCP clients on each emission.
 * Calling `server.close()` unsubscribes this listener; connected transport closure
 * also reaches the same idempotent cleanup through the SDK's `onclose` hook.
 * @param bus - Bus instance for tool execution and approval RPC.
 * @param sessionId - Session identifier for tool execution context.
 * @param options - Optional server configuration.
 * @returns Configured MCP {@link Server} instance.
 */
export async function createMcpServer(bus: IMakaioBus, sessionId: string, options?: CreateMcpServerOptions) {
  const { contextRegistry, toolDiscovery, resolveContextOverrides } = options ?? {};
  const server = new Server({ name: 'makaio', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const requestToolApproval: RequestToolApproval = (payload) => bus.request(AgentSubjects.toolApprove, payload);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const resolved = await resolveMcpTools(bus, toolDiscovery);
    return {
      tools: [...resolved.tools, ...(contextRegistry ? [buildApproveToolDefinition()] : [])],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const rawHeader = extra.requestInfo?.headers['x-adapter-session-id'];
    const adapterSessionId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

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

    const resolved = await resolveMcpTools(bus, toolDiscovery);
    const requestedTool = resolved.byMcpName.get(request.params.name);
    if (!requestedTool) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }

    // Graceful degradation by design: unknown/evicted sessions fall back to
    // process-level defaults rather than rejecting. The MCP server also runs
    // standalone (without a bridge service) where resolveContextOverrides is
    // absent, so failing closed would break the standalone path.
    const sessionOverrides = resolveContextOverrides?.(adapterSessionId);
    // Merge session-stable overrides with per-process fallbacks. Explicit
    // undefined fields in sessionOverrides must not overwrite the fallbacks,
    // so we apply ?? for each field individually rather than spreading.
    const contextOverrides: ToolExecutionContextOverrides = {
      cwd: sessionOverrides?.cwd ?? process.cwd(),
      sessionId: sessionOverrides?.sessionId ?? sessionId,
      env: sessionOverrides?.env,
      agentId: sessionOverrides?.agentId,
      turnId: sessionOverrides?.turnId,
      reasoning: sessionOverrides?.reasoning,
      toolCallId: sessionOverrides?.toolCallId,
      turnContext: sessionOverrides?.turnContext,
      constraints: sessionOverrides?.constraints,
    };

    // Payload shape matches ToolSchemas.execute.request: { toolName, input, contextOverrides }.
    // sessionId lives inside contextOverrides, not at the top level.
    const execution = await bus.requestOptional(ToolSubjects.execute, {
      toolName: requestedTool.sourceToolName,
      input: request.params.arguments ?? {},
      contextOverrides,
    });
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
 * This is the seam for attaching MCP to a shared HTTP server in the future.
 * The transport handles body parsing internally and we do not pre-parse the body,
 * otherwise the request stream would be consumed before MCP can read it.
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
 * Close an HTTP server, tolerating already-stopped state.
 * @param httpServer - HTTP server instance to close.
 * @returns Promise that resolves when close completes.
 */
async function closeHttpServerSafely(httpServer: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * Start listening and resolve the assigned port.
 * @param httpServer - Node HTTP server.
 * @param requestedPort - Port to bind (0 = auto).
 * @param onListenFailure - Cleanup callback for listen errors.
 * @returns Resolved bound port.
 */
async function listenForHttpPort(
  httpServer: http.Server,
  requestedPort: number,
  onListenFailure: (error: Error) => Promise<void>,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      void onListenFailure(error)
        .catch((cleanupError) => {
          console.error('[MCP Server] Startup cleanup failed after listen error:', cleanupError);
        })
        .finally(() => {
          reject(error);
        });
    };

    httpServer.once('error', onError);
    httpServer.listen(requestedPort, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') {
        const addressError = new Error('Unexpected server address format');
        httpServer.off('error', onError);
        void onListenFailure(addressError)
          .then(() => {
            reject(addressError);
          })
          .catch((cleanupError) => {
            reject(new AggregateError([addressError, cleanupError], 'Failed during MCP server startup'));
          });
        return;
      }
      httpServer.off('error', onError);
      resolve(addr.port);
    });
  });
}

/**
 * Start a standalone HTTP MCP server on a new `http.Server`.
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
  const contextRegistry = new McpContextRegistry();

  const sessionId = options.agentContext?.adapterSessionId ?? crypto.randomUUID();
  if (options.agentContext) {
    contextRegistry.register(sessionId, options.agentContext);
  }

  const mcpServer = await createMcpServer(bus, sessionId, {
    contextRegistry,
    toolDiscovery: options.toolDiscovery,
    resolveContextOverrides: options.resolveContextOverrides,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  if (options.onclose) {
    transport.onclose = options.onclose;
  }
  await mcpServer.connect(transport);

  const handler = createMcpRequestHandler(transport, (req) => {
    const rawUrl = req.url ?? '/';
    const queryStart = rawUrl.indexOf('?');
    if (queryStart === -1) return;

    const adapterSessionId = new URLSearchParams(rawUrl.slice(queryStart + 1)).get('adapterSessionId');
    if (adapterSessionId) {
      req.headers['x-adapter-session-id'] = adapterSessionId;
      Object.defineProperty(req, 'rawHeaders', {
        value: [...req.rawHeaders, 'x-adapter-session-id', adapterSessionId],
        configurable: true,
      });
    }
  });

  const httpServer = http.createServer(handler);

  const port = await listenForHttpPort(httpServer, options.port ?? 0, async () => {
    await Promise.allSettled([mcpServer.close(), closeHttpServerSafely(httpServer)]);
  });

  console.error(`[MCP Server] HTTP transport listening on port ${port}`);

  return {
    port,
    contextRegistry,
    close: async () => {
      // Force-close idle keep-alive connections so httpServer.close() resolves promptly.
      // Without this, connections held by the Claude Agent SDK subprocess
      // prevent the server from draining within the test timeout.
      httpServer.closeAllConnections();
      const results = await Promise.allSettled([
        mcpServer.close(),
        new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve()))),
      ]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to close HTTP MCP server resources');
      }
    },
  };
}

/**
 * Start MCP server with the configured transport.
 *
 * For the stdio transport, returns a {@link StdioMcpServerHandle} whose
 * `close()` method gracefully tears down the MCP server. Signal handling
 * is intentionally left to the composition root — library code must not
 * own process-global resources such as `process.on('SIGINT')`.
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
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP Server] Started and listening on stdio');

  return {
    close: async () => {
      await server.close();
    },
  };
}
