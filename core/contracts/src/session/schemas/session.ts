import { z } from 'zod';
import { BranchKindSchema, ImportStatusSchema, SessionContextInheritanceSchema } from './primitives.js';
import { ForkTransformsSchema } from './lifecycle-events.js';
import { MakaioSessionAgentSchema } from './agent.js';
import { ApprovalPolicySchema } from '../../harness/schemas.js';
import { ClientIdentityObservationSchema } from '../../client/account-identity.js';

/**
 * Schema for a makaio orchestration session.
 *
 * A session represents a logical conversation context that may span
 * multiple agents and adapters over time.
 */
export const MakaioSessionSchema = z.object({
  /** Unique session identifier */
  sessionId: z.string(),
  /** Timestamp when the session was created */
  createdAt: z.number(),
  /** Timestamp of last activity in the session */
  lastActivityAt: z.number(),
  /** Agents currently or previously attached to this session */
  agents: z.array(MakaioSessionAgentSchema),
  /**
   * Current session status.
   *
   * - `'active'`: Ongoing session, agent is running or paused.
   * - `'closed'`: Completed session, no longer active.
   * - `'archived'`: Manually archived by the user.
   * - `'discovered'`: Stub created from log discovery; full import not yet done.
   */
  status: z.enum(['active', 'closed', 'archived', 'discovered']),
  /** Lead agent ID (receives messages by default). Undefined if no agents yet. */
  leadAgentId: z.string().optional(),
  /** Parent session ID (for forked sessions). Undefined for root sessions. */
  parentSessionId: z.string().optional(),
  /**
   * Explicit context inheritance policy for child sessions.
   *
   * This is intentionally separate from `parentSessionId`: lineage records the
   * session graph, while this field controls prompt-history inheritance.
   */
  contextInheritance: SessionContextInheritanceSchema.optional(),
  /**
   * Root session ID for fork chains.
   * Denormalized for efficient "find all sessions in family" queries.
   * Undefined for root sessions (they ARE the root).
   */
  rootSessionId: z.string().optional(),
  /**
   * Message ID where this session forked from parent.
   * The last message that was copied from parent to this fork.
   * Undefined for root sessions.
   */
  forkPointMessageId: z.string().optional(),
  /**
   * Type of branch this session represents.
   * Undefined for root sessions (not created from another session).
   */
  branchKind: BranchKindSchema.optional(),
  /**
   * Adapter type name (e.g., 'claude-code', 'codex-mcp').
   * Identifies the source adapter for native imports.
   */
  adapterName: z.string().optional(),
  /**
   * Provider's session ID.
   * For native imports, this is the external tool's session identifier.
   */
  adapterSessionId: z.string().optional(),
  /**
   * Adapter instance ID (machine/installation specific).
   * Used to determine if native resume is possible.
   */
  adapterId: z.string().optional(),
  /** Client application this session is linked to (for example `claude-code`). */
  clientId: z.string().optional(),
  /** Canonical client account linked to this session. */
  clientAccountId: z.string().optional(),
  /** Latest raw client identity observation persisted for the session. */
  lastClientIdentityObservation: ClientIdentityObservationSchema.optional(),
  /**
   * Whether this session has been modified by Makaio orchestration.
   * False = native session, can use adapter's native resume.
   * True = Makaio modified history, must inject context.
   */
  isOrchestrated: z.boolean().optional(),
  /** Session title for sidebar display. Undefined until generated. */
  title: z.string().optional(),
  /** Session summary for search and context. Undefined until generated. */
  summary: z.string().optional(),
  /** Timestamp when summary was last updated. Used to detect staleness. */
  summaryUpdatedAt: z.number().optional(),
  /**
   * Whether this session was imported from external source.
   * - true: Imported (allow incremental re-imports)
   * - false: Created by Makaio runtime (skip on import)
   */
  isImported: z.boolean().optional(),
  /**
   * Fork transforms for context projection (fork sessions only).
   * Contains removedMessageIds and appliedPipeline configuration.
   */
  forkTransforms: ForkTransformsSchema.optional(),
  /**
   * Target working directory for this session.
   * Used to override the default working directory for forked sessions.
   */
  targetWorkingDirectory: z.string().optional(),
  /** Stamped execution target — set during first startAgent resolution. */
  executionTargetId: z.string().optional(),
  /** Tool call ID of the Agent/spawn_subagent invocation that spawned this session. Only present for subagent sessions. */
  spawningToolCallId: z.string().optional(),
  /** User-set approval policy override for this session.
   *  When set, takes precedence over the persona → profile → harness cascade.
   *  Null means "use the cascade" (default behavior).
   */
  approvalPolicyOverride: ApprovalPolicySchema.nullable().optional(),

  // ─── Import provenance ────────────────────────────────────────────

  /**
   * Identifies the external tool that produced the imported logs.
   * Null for live sessions. Examples: 'claude-code', 'codex', 'opencode'.
   */
  source: z.string().optional(),
  /**
   * Parent session's external ID (soft reference for import lineage).
   * May reference a session not yet imported.
   */
  parentExternalSessionId: z.string().optional(),
  /** Absolute path to the source log file on disk. Only for imported sessions. */
  logFilePath: z.string().optional(),
  /** Monotonic timestamp (ms) when this session was first discovered during import. */
  discoveredAt: z.number().optional(),
  /**
   * Import-specific lifecycle status.
   * - 'discovered': Found in logs, not fully imported yet
   * - 'imported': All messages imported successfully
   * - 'tracking': Imported but source file is still actively being written to
   */
  importStatus: ImportStatusSchema.optional(),
});

export type MakaioSession = z.infer<typeof MakaioSessionSchema>;

/**
 * Preview data for session list display.
 * Only populated when includePreview: true is passed to list.
 */
export const SessionPreviewDataSchema = z.object({
  /** Number of messages in the session */
  messageCount: z.number(),
  /** First user message text (fallback when title is null) */
  firstUserMessage: z.string().nullable(),
});

export type SessionPreviewData = z.infer<typeof SessionPreviewDataSchema>;

/**
 * Session with optional preview data for list display.
 */
export const SessionWithPreviewSchema = MakaioSessionSchema.extend({
  /** Preview data - only present when includePreview: true */
  preview: SessionPreviewDataSchema.optional(),
});

export type SessionWithPreview = z.infer<typeof SessionWithPreviewSchema>;
