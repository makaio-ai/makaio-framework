import type { McpAgentContext, ToolExecutionContextOverrides } from '@makaio/contracts';
import type { IMcpContextRegistry } from './context-registry.js';
import type { McpToolDiscoveryOptions } from './tool-discovery.js';

/** Resolve session-stable context overrides for an adapter session. */
export type ResolveContextOverrides = (
  adapterSessionId: string | undefined,
) => ToolExecutionContextOverrides | undefined;

/** Shared timeout option for MCP tool execution. */
interface ToolExecutionTimeoutOption {
  /** Positive timeout in milliseconds, bounded to 30 minutes. */
  toolExecutionTimeoutMs?: number;
}

/** Options for configuring MCP server startup. */
export interface McpServerOptions extends ToolExecutionTimeoutOption {
  transport: 'stdio' | 'http';
  port?: number;
  agentContext?: McpAgentContext;
  toolDiscovery?: McpToolDiscoveryOptions;
  resolveContextOverrides?: ResolveContextOverrides;
  onclose?: () => void;
}

/** Result returned for the stdio transport. */
export interface StdioMcpServerHandle {
  close: () => Promise<void>;
}

/** Result returned for the HTTP transport. */
export interface HttpMcpServerHandle {
  port: number;
  contextRegistry: IMcpContextRegistry;
  close: () => Promise<void>;
}

/** Options for creating the transport-independent MCP server. */
export interface CreateMcpServerOptions extends ToolExecutionTimeoutOption {
  contextRegistry?: IMcpContextRegistry;
  toolDiscovery?: McpToolDiscoveryOptions;
  resolveContextOverrides?: ResolveContextOverrides;
}

/** Transport-independent HTTP MCP handler options. */
export interface HttpMcpHandlerOptions extends ToolExecutionTimeoutOption {
  agentContext?: McpAgentContext;
  toolDiscovery?: McpToolDiscoveryOptions;
  onclose?: () => void;
  resolveContextOverrides?: ResolveContextOverrides;
}

/** Options for starting a standalone HTTP MCP server. */
export interface HttpMcpServerOptions extends HttpMcpHandlerOptions {
  port?: number;
}
