/**
 * Transport-independent MCP `Server` construction.
 *
 * Lives apart from the hosts that mount it (Node HTTP, fetch, stdio) because
 * all three build the same server and only differ in how bytes reach it. The
 * adapter-session shim constants live here too: they are part of the tool-call
 * contract this server reads, not of any one host's request plumbing.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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
import type { IMcpContextRegistry } from './context-registry.js';
import {
  APPROVE_TOOL_NAME,
  buildApproveToolDefinition,
  handleApproveToolCall,
  type RequestToolApproval,
} from './approve-tool.js';
import { resolveMcpTools, type McpToolDiscoveryIdentity } from './tool-discovery.js';
import { once } from './mcp-server-lifecycle.js';
import { validateToolExecutionTimeout } from './option-validation.js';
import type { CreateMcpServerOptions } from './server-options.js';

/** Query parameter name used by adapters to pass the session ID when custom headers are not available. */
export const ADAPTER_SESSION_ID_PARAM = 'adapterSessionId';

/** HTTP header name that carries the adapter session ID after query-param promotion. */
export const ADAPTER_SESSION_ID_HEADER = 'x-adapter-session-id';

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

  const cleanupRegistryChangedSubscription = once(unsubscribeRegistryChanged);

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
