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
  /**
   * Fires once when the endpoint itself closes.
   *
   * It does **not** fire when an individual MCP client disconnects or
   * terminates its session: one endpoint serves many MCP clients, and their
   * comings and goings are not endpoint lifecycle events.
   */
  onclose?: () => void;
  resolveContextOverrides?: ResolveContextOverrides;
  /**
   * Idle time (ms) with no open HTTP exchange before an MCP client session is
   * closed. A client holding its standalone SSE stream is never idle. Defaults
   * to 10 minutes.
   */
  idleTimeoutMs?: number;
  /** Interval (ms) between idle-session sweeps. Defaults to 60 seconds. */
  sweepIntervalMs?: number;
}

/** Options for starting a standalone HTTP MCP server. */
export interface HttpMcpServerOptions extends HttpMcpHandlerOptions {
  port?: number;
}
