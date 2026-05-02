import type { McpIntegrationStrategy, McpSessionResources } from '@makaio/ai-adapters-core';
import type { McpSessionContext, ToolListItem } from '@makaio/contracts';

/**
 * MCP integration strategy for the OpenAI Node adapter.
 *
 * Uses tool-injection mode — MCP tools are converted to OpenAI-compatible
 * function definitions and injected alongside native tools. The OpenAI API is
 * stateless (messages[]), so tools can be refreshed between turns.
 */
export class OpenAiNodeMcpStrategy implements McpIntegrationStrategy {
  public readonly mode = 'tool-injection' as const;
  public readonly supportsMidSessionToolChange = false;

  /**
   * Converts MCP direct-inject tools to the standard ToolListItem format.
   * @param context - Resolved MCP session context.
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
