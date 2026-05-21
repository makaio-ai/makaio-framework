import { z } from 'zod';

/**
 * Agent role in a session.
 * - lead: Primary agent that receives messages by default
 * - member: Additional agent that only receives explicit broadcasts
 */
export const AgentRoleSchema = z.enum(['lead', 'member']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/**
 * Type of branch a session represents.
 * - fork: Independent exploration (navigates away)
 * - branch: Parallel work (stays in view, may merge back)
 * - subagent: Spawned worker (auto-closes, merges result)
 * - compress: Summary-based continuation (in-place squash)
 * - rewrite: Edited history
 * - coordinator: Workflow orchestration session
 * - aside: Ephemeral read-only Q&A. Rendered inline in parent, excluded from AI context
 *          by session boundary (child sessions are never in parent's context assembly)
 */
export const BranchKindSchema = z.enum(['fork', 'branch', 'subagent', 'compress', 'rewrite', 'coordinator', 'aside']);
export type BranchKind = z.infer<typeof BranchKindSchema>;
