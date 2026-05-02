import { z } from 'zod';
import { EnrichmentFieldsSchema, ApprovalResponseSchema } from './shared.js';

/**
 * Schema for file_change_approval_request RPC
 * Request/response pair for file change approval routing via scoped bus.
 * Connector calls requestToolApproval → registerToolApprovalHandler routes to global bus → returns response.
 *
 * Note: Enrichment fields (agentId, adapterId, etc.) are auto-injected by requestToolApproval.
 */
export const FileChangeApprovalRequestSchema = {
  request: z
    .object({
      threadId: z.string(),
      turnId: z.string(),
      itemId: z.string(),
      reason: z.string().nullable(),
      grantRoot: z.string().nullable(),
      timestamp: z.number(),
    })
    .merge(EnrichmentFieldsSchema),
  response: ApprovalResponseSchema,
};

/**
 * Schema for file_change.output.delta event
 * Emitted for incremental file change updates
 */
export const FileChangeOutputDeltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
  timestamp: z.number(),
});

// Export inferred types
export type FileChangeApprovalRequest = z.infer<typeof FileChangeApprovalRequestSchema.request>;
export type FileChangeApprovalResponse = z.infer<typeof FileChangeApprovalRequestSchema.response>;
export type FileChangeOutputDelta = z.infer<typeof FileChangeOutputDeltaSchema>;
