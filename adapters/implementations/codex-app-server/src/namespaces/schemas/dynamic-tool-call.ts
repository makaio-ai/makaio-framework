import { z } from 'zod';
import { EnrichmentFieldsSchema, ApprovalResponseSchema } from './shared.js';

/**
 * Schema for dynamic_tool_call_begin event.
 *
 * Emitted when an `item/started` notification arrives for a `dynamicToolCall` item.
 * The `name` and `args` fields are populated from the cached `item/tool/call` server
 * request that was handled before (or concurrent with) the `item/started` notification.
 */
export const DynamicToolCallBeginSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  /** Item ID — same as `toolCallId` used in `item/tool/call` */
  itemId: z.string(),
  /** Tool name as declared in `dynamicTools` at `thread/start` */
  name: z.string(),
  /** Tool input arguments */
  args: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
});

/**
 * Schema for dynamic_tool_call_end event.
 *
 * Emitted when an `item/completed` notification arrives for a `dynamicToolCall` item.
 * The `output` and `success` fields are populated from the cached tool execution result.
 */
export const DynamicToolCallEndSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  /** Item ID — same as `toolCallId` used in `item/tool/call` */
  itemId: z.string(),
  /** Tool name as declared in `dynamicTools` at `thread/start` */
  name: z.string(),
  /** Serialised tool output */
  output: z.string(),
  /** Whether execution succeeded (false if the result contained an `error` key) */
  success: z.boolean(),
  timestamp: z.number(),
});

/**
 * Schema for dynamic_tool_call_approval_request RPC.
 *
 * Request/response pair for dynamic tool call approval routing via scoped bus.
 * Connector calls requestToolApproval → approval handler routes to global bus → returns response.
 *
 * Note: Enrichment fields (agentId, adapterId, etc.) are auto-injected by requestToolApproval.
 */
export const DynamicToolCallApprovalRequestSchema = {
  request: z
    .object({
      threadId: z.string(),
      turnId: z.string(),
      /** Item ID — same as `toolCallId` used in `item/tool/call` */
      itemId: z.string(),
      /** Tool name as declared in `dynamicTools` at `thread/start` */
      name: z.string(),
      /** Tool input arguments */
      args: z.record(z.string(), z.unknown()),
      timestamp: z.number(),
    })
    .merge(EnrichmentFieldsSchema),
  response: ApprovalResponseSchema,
};

// Export inferred types
export type DynamicToolCallBegin = z.infer<typeof DynamicToolCallBeginSchema>;
export type DynamicToolCallEnd = z.infer<typeof DynamicToolCallEndSchema>;
export type DynamicToolCallApprovalRequest = z.infer<typeof DynamicToolCallApprovalRequestSchema.request>;
export type DynamicToolCallApprovalResponse = z.infer<typeof DynamicToolCallApprovalRequestSchema.response>;
