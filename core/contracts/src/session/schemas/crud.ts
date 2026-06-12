import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { observability } from '@makaio/core';
import { BranchKindSchema, SessionContextInheritanceSchema } from './primitives.js';
import { ForkTransformsSchema } from './lifecycle-events.js';
import { MakaioSessionSchema, SessionWithPreviewSchema } from './session.js';
import { ApprovalPolicySchema } from '../../harness/schemas.js';

/**
 * Session CRUD RPC schemas.
 *
 * Handles basic session lifecycle operations: list, search, get, create, close, purge, update.
 */
export const CrudSchemas = {
  /**
   * List makaio sessions.
   *
   * Subject: `session.list`
   * Type: Request (RPC)
   *
   * When `includePreview: true`, each session includes a `preview` object
   * with `messageCount` and `firstUserMessage` for UI display.
   * @example
   * ```typescript
   * // Basic list
   * const { sessions } = await bus.request(SessionSubjects.list, { status: 'active' });
   *
   * // With preview data for UI display
   * const { sessions, total } = await bus.request(SessionSubjects.list, {
   *   status: 'all',
   *   includePreview: true,
   *   limit: 20,
   * });
   * ```
   */
  list: {
    // z.object() is intentional: host code extends this base schema at
    // runtime via MakaioBus.extendSubject() (adds projectId, worktreeId, etc.).
    // The bus validates against the extended schema; TypeScript enforces scope
    // field usage through the extended subject types.
    request: observability.schema(
      z.object({
        /** Filter by session status. Defaults to 'all' if not specified. */
        status: z.enum(['active', 'closed', 'archived', 'discovered', 'all']).optional(),
        /** Maximum number of sessions to return */
        limit: z.number().int().min(1).optional(),
        /** Number of sessions to skip (for pagination) */
        offset: observability.hidden(z.number().int().min(0).optional()),
        /** Include preview data (messageCount, firstUserMessage) */
        includePreview: z.boolean().optional(),
        /** Filter by execution target ID (only sessions stamped with this target) */
        executionTargetId: z.string().optional(),
      }),
      { traceAll: true },
    ),
    response: z.object({
      /** Array of matching sessions (with optional preview data) */
      sessions: z.array(SessionWithPreviewSchema),
      /** Total count for pagination */
      total: z.number(),
    }),
  },

  /**
   * Search sessions by content using full-text search
   * (FTS5 on SQLite, tsvector on Postgres).
   *
   * Subject: `session.search`
   * Type: Request (RPC)
   *
   * Searches across session message content. Always includes preview data
   * since search is content-focused.
   * @example
   * ```typescript
   * const { sessions, total } = await bus.request(SessionSubjects.search, {
   *   query: 'authentication bug',
   *   limit: 20,
   * });
   * ```
   */
  search: {
    request: z.object({
      /** Full-text search query */
      query: z.string(),
      /** Maximum number of sessions to return */
      limit: z.number().int().min(1).optional(),
      /** Filter by session status */
      status: z.enum(['active', 'closed', 'archived', 'discovered', 'all']).optional(),
      /** Filter by import origin */
      isImported: z.boolean().optional(),
    }),
    response: z.object({
      /** Array of matching sessions with preview data */
      sessions: z.array(SessionWithPreviewSchema),
      /** Total count of matches */
      total: z.number(),
    }),
  },

  /**
   * Get a specific session by ID.
   *
   * Subject: `session.get`
   * Type: Request (RPC)
   * @example
   * ```typescript
   * const { session } = await bus.request(SessionSubjects.get, { sessionId: 'abc123' });
   * if (session) {
   *   console.debug(`Session status: ${session.status}`);
   * }
   * ```
   */
  get: {
    request: z.object({
      /** Session ID to retrieve */
      sessionId: z.string(),
    }),
    response: z.object({
      /** The session if found, null otherwise */
      session: MakaioSessionSchema.nullable(),
    }),
  },

  /**
   * Create a new makaio session.
   *
   * Subject: `session.create`
   * Type: Request (RPC)
   * @example
   * ```typescript
   * const { sessionId } = await bus.request(SessionSubjects.create, {});
   * console.debug(`Created session: ${sessionId}`);
   * ```
   */
  create: {
    request: z
      .object({
        /** Optional client-provided session ID (server generates if omitted) */
        sessionId: z.string().optional(),
        /** Parent session ID (for forked sessions) */
        parentSessionId: z.string().optional(),
        /** Explicit parent-history inheritance policy for child sessions. */
        contextInheritance: SessionContextInheritanceSchema.optional(),
        /** Message ID where this fork diverges from parent */
        forkPointMessageId: z.string().optional(),
        /** Type of branch this session represents */
        branchKind: BranchKindSchema.optional(),
        /** Fork transforms for context projection (fork sessions only) */
        forkTransforms: ForkTransformsSchema.optional(),
        /** Session title for sidebar display */
        title: z.string().optional(),
        /** Target working directory for this session */
        targetWorkingDirectory: z.string().optional(),
        /** Execution target to stamp on the session at creation time. */
        executionTargetId: z.string().optional(),
        /** Tool call ID of the spawn_subagent invocation that triggered this session. Only set for subagent sessions. */
        spawningToolCallId: z.string().optional(),
        /**
         * Window ID that initiated the session creation.
         * Preserved as creation provenance for the originating tab.
         * Optional - web clients should provide workerCoordinator.currentWindowId;
         * non-web clients (CLI, backend) can omit (defaults to 'server').
         */
        originWindowId: z.string().optional(),
      })
      .superRefine((value, ctx) => {
        if (value.spawningToolCallId && value.branchKind !== 'subagent') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['spawningToolCallId'],
            message: 'spawningToolCallId is only valid for subagent sessions',
          });
        }
      }),
    response: z.object({
      /** ID of the newly created session */
      sessionId: z.string(),
    }),
  },

  /**
   * Close an existing session.
   *
   * Subject: `session.close`
   * Type: Request (RPC)
   *
   * Closing a session marks it as inactive but retains session data and events
   * for potential resume. Use `purge` to permanently delete all data.
   * @example
   * ```typescript
   * const { success } = await bus.request(SessionSubjects.close, { sessionId: 'abc123' });
   * if (success) {
   *   console.debug('Session closed successfully');
   * }
   * ```
   */
  close: {
    request: z.object({
      /** Session ID to close */
      sessionId: z.string(),
    }),
    response: z.object({
      /** Whether the session was successfully closed */
      success: z.boolean(),
    }),
  },

  /**
   * Resume a closed session back to active.
   *
   * Subject: `session.resume`
   * Type: Request (RPC)
   */
  resume: {
    request: z.object({
      /** Session ID to resume */
      sessionId: z.string(),
    }),
    response: z.object({
      /** Whether the session was successfully resumed */
      success: z.boolean(),
    }),
  },

  /**
   * Archive a closed session.
   *
   * Subject: `session.archive`
   * Type: Request (RPC)
   */
  archive: {
    request: z.object({
      /** Session ID to archive */
      sessionId: z.string(),
    }),
    response: z.object({
      /** Whether the session was successfully archived */
      success: z.boolean(),
    }),
  },

  /**
   * Permanently delete a session and all its events.
   *
   * Subject: `session.purge`
   * Type: Request (RPC)
   *
   * Unlike `close`, this permanently removes all session data including
   * event history. Use when session data is no longer needed (e.g., user
   * explicitly deletes conversation, data retention policy).
   *
   * **Requires session to be archived first.** This ensures no agents are still
   * emitting events that would race with deletion.
   * @example
   * ```typescript
   * // First close then archive the session
   * await bus.request(SessionSubjects.close, { sessionId: 'abc123' });
   * await bus.request(SessionSubjects.archive, { sessionId: 'abc123' });
   *
   * // Then purge permanently
   * const { success, eventsDeleted } = await bus.request(SessionSubjects.purge, {
   *   sessionId: 'abc123',
   * });
   * if (success) {
   *   console.debug(`Purged session with ${eventsDeleted} events`);
   * }
   * ```
   */
  purge: {
    request: z.object({
      /** Session ID to purge */
      sessionId: z.string(),
    }),
    response: z.object({
      /** Whether the session was found and purged */
      success: z.boolean(),
      /** Number of events deleted (if successful) */
      eventsDeleted: z.number().optional(),
      /** Error message (if unsuccessful) */
      error: z.string().optional(),
    }),
  },

  /**
   * Update specific session fields (partial update).
   *
   * Subject: `session.update`
   * Type: Request (RPC)
   *
   * Unlike re-setting the entire session, this performs a targeted update
   * of specific fields.
   * @example
   * ```typescript
   * // Update session approval policy
   * const { success } = await bus.request(SessionSubjects.update, {
   *   sessionId: 'abc123',
   *   approvalPolicyOverride: 'full-access',
   * });
   *
   * // Rename session
   * const { success } = await bus.request(SessionSubjects.update, {
   *   sessionId: 'abc123',
   *   title: 'My renamed session',
   * });
   * ```
   */
  update: {
    request: z.object({
      /** Session ID to update */
      sessionId: z.string(),
      /** Execution target ID to stamp on the session (null to unlink) */
      executionTargetId: z.string().nullable().optional(),
      /** Approval policy override (null to clear and revert to cascade) */
      approvalPolicyOverride: ApprovalPolicySchema.nullable().optional(),
      /** Session title for sidebar display (renames the session) */
      title: z.string().optional(),
    }),
    response: z.object({
      /** Whether the update succeeded */
      success: z.boolean(),
    }),
  },

  /**
   * Get a session by its adapter session ID.
   *
   * Subject: `session.getByAdapterSessionId`
   * Type: Request (RPC)
   *
   * Used by log import to check if a session already exists for a given
   * external session identifier (e.g., Claude Code session ID).
   * @example
   * ```typescript
   * const { session } = await bus.request(SessionSubjects.getByAdapterSessionId, {
   *   adapterSessionId: 'claude-code-session-abc',
   * });
   * if (session && !session.isImported) {
   *   // Session was created by Makaio runtime, skip import
   * }
   * ```
   */
  getByAdapterSessionId: {
    request: z.object({
      /** Adapter session ID to look up */
      adapterSessionId: z.string(),
    }),
    response: z.object({
      /** The session if found, null otherwise */
      session: MakaioSessionSchema.nullable(),
    }),
  },

  /**
   * Get session counts by status for filter UI.
   *
   * Subject: `session.getStatusCounts`
   * Type: Request (RPC)
   *
   * Returns counts for all statuses in a single efficient query.
   * Useful for status filter UI badges that show totals regardless of current filter.
   * @example
   * ```typescript
   * const { all, active, closed, archived, discovered } = await bus.request(
   *   SessionSubjects.getStatusCounts,
   *   {},
   * );
   * // Display: All (15) | Active (8) | Closed (5) | Archived (2) | Discovered (0)
   * ```
   */
  getStatusCounts: {
    request: z.object({}),
    response: z.object({
      /** Total count of all sessions */
      all: z.number(),
      /** Count of active sessions */
      active: z.number(),
      /** Count of closed sessions */
      closed: z.number(),
      /** Count of archived sessions */
      archived: z.number(),
      /** Count of discovered (stub) sessions not yet fully imported */
      discovered: z.number(),
    }),
  },
} satisfies SchemaRecord;
