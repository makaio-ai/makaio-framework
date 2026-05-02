import type { McpIntegrationStrategy, McpSessionResources } from '@makaio/ai-adapters-core';
import type { McpSessionContext, ToolListItem } from '@makaio/contracts';

/**
 * MCP integration strategy for the Anthropic SDK adapter.
 *
 * Uses tool-injection mode — MCP tools are converted to Anthropic-compatible
 * tool definitions and injected alongside native tools. The Anthropic API is
 * stateless (messages[]), so tools can be refreshed between turns.
 */
export class AnthropicSdkMcpStrategy implements McpIntegrationStrategy {
  public readonly mode = 'tool-injection' as const;
  public readonly supportsMidSessionToolChange = false;

  /**
   * Converts MCP direct-inject tools to the standard ToolListItem format
   * for injection into the adapter's tool list.
   * @param context - Resolved MCP session context with direct and discoverable tools.
   * @returns Tool-injection resources with converted tool definitions.
   */
  public async prepareMcpForSession(context: McpSessionContext): Promise<McpSessionResources> {
    const tools: ToolListItem[] = context.directTools.map((tool) => ({
      name: tool.fullName,
      description: tool.description ?? '',
      toolsetName: tool.serverName,
      inputSchema: tool.inputSchema,
    }));
    return { mode: 'tool-injection', tools };
  }
}
