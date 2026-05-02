import type { McpIntegrationStrategy, McpSessionResources } from '@makaio/ai-adapters-core';
import type { McpResolvedServer, McpSessionContext } from '@makaio/contracts';

/**
 * MCP integration strategy for the Claude Code CLI adapter.
 *
 * Uses native-passthrough mode — resolved server configs are baked into the
 * CLI invocation via `--mcp-config` on each turn. Mid-session tool changes
 * are not supported; deferred injection via the next turn applies naturally.
 */
export class ClaudeCodeCliMcpStrategy implements McpIntegrationStrategy {
  public readonly mode = 'native-passthrough' as const;
  public readonly supportsMidSessionToolChange = false;

  /**
   * Converts Makaio resolved servers to a keyed record for CLI config injection.
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
