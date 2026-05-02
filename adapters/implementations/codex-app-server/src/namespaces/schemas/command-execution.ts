import { z } from 'zod';
import { EnrichmentFieldsSchema, ApprovalResponseSchema } from './shared.js';

/**
 * Schema for exec_command.begin event
 * Emitted when a command execution starts
 */
export const ExecCommandBeginSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for exec_approval_request RPC
 * Request/response pair for command approval routing via scoped bus.
 * Connector calls requestToolApproval → registerToolApprovalHandler routes to global bus → returns response.
 *
 * Note: Enrichment fields (agentId, adapterId, etc.) are auto-injected by requestToolApproval.
 */
export const ExecApprovalRequestSchema = {
  request: z
    .object({
      threadId: z.string(),
      turnId: z.string(),
      callId: z.string(),
      command: z.array(z.string()),
      cwd: z.string(),
      reason: z.string().nullable(),
      timestamp: z.number(),
    })
    .merge(EnrichmentFieldsSchema),
  response: ApprovalResponseSchema,
};

/**
 * Schema for exec_command.output.delta event
 * Emitted for incremental output from a running command
 */
export const ExecCommandOutputDeltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  chunk: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for exec_command.end event
 * Emitted when a command execution completes
 */
export const ExecCommandEndSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  exitCode: z.number(),
  timestamp: z.number(),
});

// Export inferred types
export type ExecCommandBegin = z.infer<typeof ExecCommandBeginSchema>;
export type ExecApprovalRequest = z.infer<typeof ExecApprovalRequestSchema.request>;
export type ExecApprovalResponse = z.infer<typeof ExecApprovalRequestSchema.response>;
export type ExecCommandOutputDelta = z.infer<typeof ExecCommandOutputDeltaSchema>;
export type ExecCommandEnd = z.infer<typeof ExecCommandEndSchema>;
