import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';

/**
 * MCP tool use content block parameter
 * @see BetaMCPToolUseBlockParam from \@anthropic-ai/sdk
 */
export const BetaMCPToolUseBlockParamSchema = z.object({
  id: z.string(),
  input: z.record(z.string(), z.unknown()),
  name: z.string(),
  /**
   * The name of the MCP server
   */
  server_name: z.string(),
  type: z.literal('mcp_tool_use'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
});

export type BetaMCPToolUseBlockParam = z.infer<typeof BetaMCPToolUseBlockParamSchema>;
