import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';
import { BetaCodeExecutionToolResultErrorCodeSchema } from '../shared/code-execution-error-codes.js';

/**
 * Code execution output block parameter
 * @see BetaCodeExecutionOutputBlockParam from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionOutputBlockParamSchema = z.object({
  file_id: z.string(),
  type: z.literal('code_execution_output'),
});

/**
 * Code execution result block parameter
 * @see BetaCodeExecutionResultBlockParam from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionResultBlockParamSchema = z.object({
  content: z.array(BetaCodeExecutionOutputBlockParamSchema),
  return_code: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  type: z.literal('code_execution_result'),
});

/**
 * Code execution tool result error parameter
 * @see BetaCodeExecutionToolResultErrorParam from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionToolResultErrorParamSchema = z.object({
  error_code: BetaCodeExecutionToolResultErrorCodeSchema,
  type: z.literal('code_execution_tool_result_error'),
});

/**
 * Code execution tool result block parameter content
 * @see BetaCodeExecutionToolResultBlockParamContent from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionToolResultBlockParamContentSchema = z.union([
  BetaCodeExecutionToolResultErrorParamSchema,
  BetaCodeExecutionResultBlockParamSchema,
]);

/**
 * Code execution tool result block parameter
 * @see BetaCodeExecutionToolResultBlockParam from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionToolResultBlockParamSchema = z.object({
  content: BetaCodeExecutionToolResultBlockParamContentSchema,
  tool_use_id: z.string(),
  type: z.literal('code_execution_tool_result'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
});

export type BetaCodeExecutionOutputBlockParam = z.infer<typeof BetaCodeExecutionOutputBlockParamSchema>;
export type BetaCodeExecutionResultBlockParam = z.infer<typeof BetaCodeExecutionResultBlockParamSchema>;
export type BetaCodeExecutionToolResultErrorParam = z.infer<typeof BetaCodeExecutionToolResultErrorParamSchema>;
export type BetaCodeExecutionToolResultBlockParamContent = z.infer<
  typeof BetaCodeExecutionToolResultBlockParamContentSchema
>;
export type BetaCodeExecutionToolResultBlockParam = z.infer<typeof BetaCodeExecutionToolResultBlockParamSchema>;
