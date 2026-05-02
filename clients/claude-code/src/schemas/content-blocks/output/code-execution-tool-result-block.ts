import { z } from 'zod';
import { BetaCodeExecutionToolResultErrorCodeSchema } from '../shared/code-execution-error-codes.js';

/**
 * Code execution output block
 * @see BetaCodeExecutionOutputBlock from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionOutputBlockSchema = z.object({
  file_id: z.string(),
  type: z.literal('code_execution_output'),
});

/**
 * Code execution result block
 * @see BetaCodeExecutionResultBlock from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionResultBlockSchema = z.object({
  content: z.array(BetaCodeExecutionOutputBlockSchema),
  return_code: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  type: z.literal('code_execution_result'),
});

/**
 * Code execution tool result error
 * @see BetaCodeExecutionToolResultError from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionToolResultErrorSchema = z.object({
  error_code: BetaCodeExecutionToolResultErrorCodeSchema,
  type: z.literal('code_execution_tool_result_error'),
});

/**
 * Code execution tool result block content
 * @see BetaCodeExecutionToolResultBlockContent from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionToolResultBlockContentSchema = z.union([
  BetaCodeExecutionToolResultErrorSchema,
  BetaCodeExecutionResultBlockSchema,
]);

/**
 * Code execution tool result block
 * @see BetaCodeExecutionToolResultBlock from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionToolResultBlockSchema = z.object({
  content: BetaCodeExecutionToolResultBlockContentSchema,
  tool_use_id: z.string(),
  type: z.literal('code_execution_tool_result'),
});

export type BetaCodeExecutionOutputBlock = z.infer<typeof BetaCodeExecutionOutputBlockSchema>;
export type BetaCodeExecutionResultBlock = z.infer<typeof BetaCodeExecutionResultBlockSchema>;
export type BetaCodeExecutionToolResultError = z.infer<typeof BetaCodeExecutionToolResultErrorSchema>;
export type BetaCodeExecutionToolResultBlockContent = z.infer<typeof BetaCodeExecutionToolResultBlockContentSchema>;
export type BetaCodeExecutionToolResultBlock = z.infer<typeof BetaCodeExecutionToolResultBlockSchema>;
