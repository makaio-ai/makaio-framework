import { z } from 'zod';
import { AgentToolApproveSchema } from '@makaio/contracts';

/**
 * Schema for Gemini tool approval request/response.
 * Mirrors ToolCallRequestInfo from \@google/gemini-cli-core for SDK-level approval.
 *
 * Request uses Gemini-native structure, response uses generic approval schema.
 */
export const GeminiToolApprovalSchema = {
  request: z.object({
    callId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    isClientInitiated: z.boolean(),
    prompt_id: z.string(),
    adapterId: z.string(),
    adapterName: z.string(),
    agentId: z.string(),
    /** LLM reasoning/thinking accumulated before this tool call (when available) */
    reasoning: z.string().optional(),
  }),
  response: AgentToolApproveSchema.response,
};

export type GeminiToolApprovalRequest = z.infer<typeof GeminiToolApprovalSchema.request>;
export type GeminiToolApprovalResponse = z.infer<typeof GeminiToolApprovalSchema.response>;
