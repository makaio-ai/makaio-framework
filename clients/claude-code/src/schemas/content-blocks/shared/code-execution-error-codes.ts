import { z } from 'zod';

/**
 * Code execution tool result error codes
 * Shared between input and output content blocks
 * @see BetaCodeExecutionToolResultErrorCode from \@anthropic-ai/sdk
 */
export const BetaCodeExecutionToolResultErrorCodeSchema = z.enum([
  'invalid_tool_input',
  'unavailable',
  'too_many_requests',
  'execution_time_exceeded',
]);

export type BetaCodeExecutionToolResultErrorCode = z.infer<typeof BetaCodeExecutionToolResultErrorCodeSchema>;
