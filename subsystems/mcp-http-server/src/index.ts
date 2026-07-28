/**
 * Framework-level MCP HTTP server.
 *
 * Provides the HTTP transport bridge that subprocess-based adapters
 * (claude-agent-sdk, claude-code-cli) use to route tool calls and
 * approval requests back to the Makaio bus.
 */

export {
  ADAPTER_SESSION_ID_HEADER,
  ADAPTER_SESSION_ID_PARAM,
  createMcpServer,
} from './create-mcp-server.js';

export {
  createHttpMcpHandler,
  startHttpMcpServer,
  startMcpServer,
  type CreateMcpServerOptions,
  type McpServerOptions,
  type HttpMcpHandlerHandle,
  type HttpMcpHandlerOptions,
  type HttpMcpServerHandle,
  type StdioMcpServerHandle,
  type HttpMcpServerOptions,
  type ResolveContextOverrides,
  type McpToolDiscoveryIdentity,
  type McpToolEntry,
  type McpToolDiscoveryOptions,
  type RequestToolApproval,
  type ToolApproveRequestPayload,
  type ToolApproveResponse,
} from './server.js';

export { createFetchMcpHandler, type FetchMcpHandlerHandle } from './fetch-handler.js';

export { createMcpEndpoint, type CreateMcpTransport, type McpEndpoint } from './mcp-endpoint.js';

export {
  McpTransportRegistry,
  type CreateMcpSession,
  type McpCreateFailureResult,
  type McpRouteRequest,
  type McpRouteResult,
  type McpSessionHooks,
  type McpTransportRegistryOptions,
} from './mcp-transport-registry.js';

export type { McpAgentContext } from '@makaio/contracts';

export { McpContextRegistry, type IMcpContextRegistry } from './context-registry.js';

export { resolveMcpTools, toolInfoToMcpTool, type PluginToolsetMap, type McpResolvedTools } from './tool-discovery.js';

export { APPROVE_TOOL_NAME } from './approve-tool.js';

export { McpServerBridgeService } from './mcp-server-bridge-service.js';

export {
  startMcpClientBridge,
  type McpClientBridgeHandle,
  type McpClientBridgeOptions,
  type McpBridgedTool,
  type McpCallToolResult,
} from './mcp-client-bridge.js';
