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

/**
 * Controls whether a child session receives parent conversation history on its first turn.
 *
 * - `parent-history`: assemble projected parent history through the fork context path.
 * - `none`: keep the child context clean while preserving parent-child lineage.
 */
export const SessionContextInheritanceSchema = z.enum(['parent-history', 'none']);
export type SessionContextInheritance = z.infer<typeof SessionContextInheritanceSchema>;

/**
 * Currency state of the session row's provider-native resume identity.
 *
 * The sessions row carries two distinct provider-session concepts:
 * `adapterSessionId` is the **immutable origin identity** (import key,
 * write-once), while `currentAdapterSessionId` plus this state form the
 * **resume currency** — which provider session, if any, a resume attach may
 * legitimately target right now.
 *
 * - `inherited`: the provider session has never moved, so the origin
 *   `adapterSessionId` still is the valid currency. Default for pre-existing
 *   rows and for imports.
 * - `moved`: the provider session moved but the provider has not confirmed a
 *   replacement yet. Neither the origin ID nor `currentAdapterSessionId` may
 *   be resumed — callers degrade to fresh-with-history.
 * - `confirmed`: `currentAdapterSessionId` is the provider-confirmed currency
 *   and supersedes the origin ID for resume purposes.
 */
export const AdapterSessionCurrencyStateSchema = z.enum(['inherited', 'moved', 'confirmed']);
export type AdapterSessionCurrencyState = z.infer<typeof AdapterSessionCurrencyStateSchema>;

/**
 * Import-specific lifecycle status.
 * - 'discovered': Found in logs, not fully imported yet
 * - 'imported': All messages imported successfully
 * - 'tracking': Imported but source file is still actively being written to
 */
export const ImportStatusSchema = z.enum(['discovered', 'imported', 'tracking']);
export type ImportStatus = z.infer<typeof ImportStatusSchema>;
