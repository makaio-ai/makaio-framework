import { z } from 'zod';
import { BetaTextBlockSchema } from './text-block.js';

/**
 * MCP tool result content block
 * @see BetaMCPToolResultBlock from \@anthropic-ai/sdk
 */
export const BetaMCPToolResultBlockSchema = z.object({
  content: z.union([z.string(), z.array(BetaTextBlockSchema)]),
  is_error: z.boolean(),
  tool_use_id: z.string(),
  type: z.literal('mcp_tool_result'),
});

export type BetaMCPToolResultBlock = z.infer<typeof BetaMCPToolResultBlockSchema>;
