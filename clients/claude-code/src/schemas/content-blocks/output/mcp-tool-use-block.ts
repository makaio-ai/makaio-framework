import { z } from 'zod';

/**
 * MCP tool use content block
 * @see BetaMCPToolUseBlock from \@anthropic-ai/sdk
 */
export const BetaMCPToolUseBlockSchema = z.object({
  id: z.string(),
  input: z.looseObject({}),
  name: z.string(),
  server_name: z.string(),
  type: z.literal('mcp_tool_use'),
});

export type BetaMCPToolUseBlock = z.infer<typeof BetaMCPToolUseBlockSchema>;
