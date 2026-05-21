import { z } from 'zod';
import { BranchKindSchema } from './primitives.js';

/**
 * Information about a child session for fork display.
 * Used by getChildren enriched response.
 */
export const ForkChildInfoSchema = z.object({
  /** Child session ID */
  sessionId: z.string(),
  /** Session title (null if not yet generated) */
  title: z.string().nullable(),
  /** Message ID where this fork diverges from parent (Makaio message ID, normalized) */
  forkPointMessageId: z.string().nullable(),
  /** Type of branch (fork, branch, subagent, compress, rewrite) */
  branchKind: BranchKindSchema.nullable(),
  /** Number of messages in this fork (owned only, not inherited) */
  messageCount: z.number(),
  /** Whether this fork has its own children (for grandchild hints) */
  hasChildren: z.boolean(),
  /** Tool call ID of the Agent/spawn_subagent invocation that spawned this subagent (absent for non-subagent forks or legacy imports). */
  spawningToolCallId: z.string().optional(),
});

export type ForkChildInfo = z.infer<typeof ForkChildInfoSchema>;
