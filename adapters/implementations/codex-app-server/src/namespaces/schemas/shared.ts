import { z } from 'zod';

/**
 * Enrichment fields auto-injected by requestToolApproval.
 * These are added by the connector's base class, not passed by the caller.
 *
 * Shared across command-execution and file-change approval schemas.
 */
export const EnrichmentFieldsSchema = z.object({
  agentId: z.string().optional(),
  adapterId: z.string().optional(),
  adapterName: z.string().optional(),
  adapterSessionId: z.string().optional(),
});

/**
 * Shared response schema for approval RPCs (exec and file-change).
 *
 * Both command execution and file change approval return
 * the same accept/decline decision format.
 */
export const ApprovalResponseSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  message: z.string().optional(),
});
