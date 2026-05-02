import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';
import { BetaTextBlockParamSchema } from './text-block-param.js';

/**
 * MCP tool result content block parameter
 * @see BetaRequestMCPToolResultBlockParam from \@anthropic-ai/sdk
 */
export const BetaMCPToolResultBlockParamSchema = z.object({
  tool_use_id: z.string(),
  type: z.literal('mcp_tool_result'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
  content: z.union([z.string(), z.array(BetaTextBlockParamSchema)]).optional(),
  is_error: z.boolean().optional(),
});

export type BetaMCPToolResultBlockParam = z.infer<typeof BetaMCPToolResultBlockParamSchema>;
