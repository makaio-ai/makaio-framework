import type { McpIntegrationStrategy, McpSessionResources } from '@makaio/ai-adapters-core';
import type { McpResolvedServer, McpSessionContext } from '@makaio/contracts';

/**
 * MCP integration strategy for the Claude Agent SDK adapter.
 *
 * Uses native-passthrough mode — the SDK manages MCP server connections directly.
 * Makaio provides the resolved server list; the SDK handles transport and tool routing.
 *
 * Upstream servers from `McpSessionContext.servers` are baked into the SDK query at
 * creation time via `buildQueryOptions`, and refreshed mid-session via the connector's
 * `ClaudeConnectorSession.updateMcpServers()` seam which delegates to `Query.setMcpServers()`.
 */
export class ClaudeAgentSdkMcpStrategy implements McpIntegrationStrategy {
  public readonly mode = 'native-passthrough' as const;
  public readonly supportsMidSessionToolChange = true;

  /**
   * Converts Makaio resolved servers to SDK-compatible server config.
   * @param context - Resolved MCP session context with server list and tools.
   * @returns Native-passthrough resources with server configs keyed by name.
   */
  public async prepareMcpForSession(context: McpSessionContext): Promise<McpSessionResources> {
    const servers: Record<string, McpResolvedServer> = {};
    for (const server of context.servers) {
      servers[server.name] = server;
    }
    return { mode: 'native-passthrough', servers };
  }
}
