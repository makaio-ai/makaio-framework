import { sql } from 'drizzle-orm';
import { index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { index as pgIndex, uniqueIndex as pgUniqueIndex, check as pgCheck } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Sessions table schema.
 *
 * Stores makaio orchestration sessions. Each session represents a logical
 * conversation context that may span multiple agents and adapters.
 *
 * SEAM: The `sessionId` column is the primary key that extensions can
 * reference for their own decorator tables (e.g., `extension_chat_messages`).
 */
export const sessionsDual = defineDualTable(
  'sessions',
  (c) => ({
    /**
     * Unique session identifier.
     * Primary key, referenced by agents and future plugin tables.
     */
    sessionId: c.text('session_id').primaryKey(),

    /**
     * Timestamp when the session was created.
     * Stored as Unix timestamp in milliseconds.
     */
    createdAt: c.epochMs('created_at').notNull(),

    /**
     * Timestamp of last activity in the session.
     * Stored as Unix timestamp in milliseconds.
     */
    lastActivityAt: c.epochMs('last_activity_at').notNull(),

    /**
     * Current session status.
     * - 'active': Session is open and accepting activity
     * - 'closed': Session has been terminated
     * - 'archived': Session is hidden from default views, pending purge
     * - 'discovered': Stub from log discovery; full import not yet done
     */
    status: c.textEnum('status', { enum: ['active', 'closed', 'archived', 'discovered'] as const }).notNull(),

    /**
     * Lead agent ID (receives messages by default).
     * Null if no agents have been added yet.
     */
    leadAgentId: c.text('lead_agent_id'),

    /**
     * Parent session ID for forked sessions.
     * Null for root sessions.
     */
    parentSessionId: c.text('parent_session_id'),

    /**
     * Controls whether a child session inherits parent conversation history.
     * Null preserves legacy behavior for existing sessions.
     */
    contextInheritance: c.textEnum('context_inheritance', {
      enum: ['parent-history', 'none'] as const,
    }),

    /**
     * Root session ID for fork chains.
     * Denormalized for efficient "find all sessions in family" queries.
     * Null for root sessions (they ARE the root).
     */
    rootSessionId: c.text('root_session_id'),

    /**
     * Message ID where this session forked from parent.
     * The last message that was copied from parent to this fork.
     * Null for root sessions.
     */
    forkPointMessageId: c.text('fork_point_message_id'),

    /**
     * Type of branch this session represents.
     * - 'fork': Independent exploration (navigates away)
     * - 'branch': Parallel work (stays in view, may merge back)
     * - 'subagent': Spawned worker (auto-closes, merges result)
     * - 'compress': Summary-based continuation (in-place squash)
     * - 'rewrite': Edited history
     * - 'coordinator': Workflow orchestration session
     * - 'aside': Ephemeral read-only Q&A, rendered inline in parent
     * Null for root sessions (not created from another session).
     */
    branchKind: c.textEnum('branch_kind', {
      enum: ['fork', 'branch', 'subagent', 'compress', 'rewrite', 'coordinator', 'aside'] as const,
    }),

    /**
     * Adapter type name (e.g., 'claude-code', 'codex-mcp').
     * Identifies the source adapter for native imports.
     */
    adapterName: c.text('adapter_name'),

    /**
     * Provider's session ID.
     * For native imports, this is the external tool's session identifier.
     */
    adapterSessionId: c.text('adapter_session_id'),

    /**
     * Adapter instance ID (machine/installation specific).
     * Used to determine if native resume is possible.
     */
    adapterId: c.text('adapter_id'),

    /**
     * Client application this session is linked to (for example `claude-code`).
     */
    clientId: c.text('client_id'),

    /**
     * Canonical client account linked to this session.
     */
    clientAccountId: c.text('client_account_id'),

    /**
     * Latest raw client identity observation persisted for the session.
     * Stored as a JSON string.
     */
    lastClientIdentityObservation: c.text('last_client_identity_observation'),

    /**
     * Whether this session has been modified by Makaio orchestration.
     * False = native session, can use adapter's native resume.
     * True = Makaio modified history, must inject context.
     */
    isOrchestrated: c.bool('is_orchestrated').default(false),

    /**
     * Session title for sidebar display.
     * Generated after conversation develops. NULL until generated.
     */
    title: c.text('title'),

    /**
     * Session summary for search and context.
     * Generated after conversation develops. NULL until generated.
     */
    summary: c.text('summary'),

    /**
     * Timestamp when summary was last updated.
     * Used to detect staleness for regeneration.
     */
    summaryUpdatedAt: c.epochMs('summary_updated_at'),

    /**
     * Whether this session was imported from external source.
     * - true: Imported (allow incremental re-imports)
     * - false/null: Created by Makaio runtime (skip on import)
     */
    isImported: c.bool('is_imported').default(false),

    /**
     * Fork transforms (JSON string).
     * Stored on fork sessions for getFullConversation() context projection.
     * Contains removedMessageIds and appliedPipeline configuration.
     */
    forkTransforms: c.text('fork_transforms'),

    /**
     * Target working directory for this session.
     * Used to override the default working directory for forked sessions.
     */
    targetWorkingDirectory: c.text('target_working_directory'),

    /**
     * Stamped execution target ID.
     * Set during first startAgent resolution. Null until resolved.
     */
    executionTargetId: c.text('execution_target_id'),

    /**
     * User-set approval policy override for this session.
     * When set, takes precedence over the persona → profile → harness cascade.
     * Null (default) means "use the cascade defaults".
     */
    approvalPolicyOverride: c.textEnum('approval_policy_override', {
      enum: ['reject', 'always-ask', 'full-access'] as const,
    }),

    /**
     * Tool call ID of the Agent/spawn_subagent invocation that spawned this session.
     * Only set for subagent sessions. Null for root/fork sessions.
     */
    spawningToolCallId: c.text('spawning_tool_call_id'),

    // ─── Import provenance fields ───────────────────────────────────────

    /**
     * Identifies the external tool that produced the imported logs.
     * For live sessions this is null; for imports it identifies the source
     * (e.g., 'claude-code', 'codex', 'opencode').
     */
    source: c.text('source'),

    /**
     * Parent session's external ID (soft reference for import lineage).
     * May reference a session not yet imported — resolves when parent is imported.
     * Null for root sessions or live sessions.
     */
    parentExternalSessionId: c.text('parent_external_session_id'),

    /**
     * Absolute path to the source log file on disk.
     * Only set for imported sessions. Used for cursor resumption and deduplication.
     */
    logFilePath: c.text('log_file_path'),

    /**
     * Monotonic timestamp (ms) when this session was first discovered during import.
     * Used for created-detection in upsert logic. Null for live sessions.
     */
    discoveredAt: c.epochMs('discovered_at'),

    /**
     * Import-specific lifecycle status. Null for live sessions.
     * - 'discovered': Found in logs, not fully imported yet
     * - 'imported': All messages imported successfully
     * - 'tracking': Imported but source file is still actively being written to
     */
    importStatus: c.textEnum('import_status', {
      enum: ['discovered', 'imported', 'tracking'] as const,
    }),
  }),
  {
    sqlite: (t) => [
      uniqueIndex('uniq_sessions_source_adapter_session_id').on(t.source, t.adapterSessionId),
      uniqueIndex('uniq_sessions_log_file_path').on(t.logFilePath),
      index('sessions_adapter_session_id_idx').on(t.adapterSessionId),
      index('idx_sessions_import_status').on(t.importStatus),
      index('sessions_execution_target_id_idx').on(t.executionTargetId),
      index('idx_sessions_parent_session_id').on(t.parentSessionId),
      check(
        'sessions_import_status_check',
        sql`${t.importStatus} IS NULL OR ${t.importStatus} IN ('discovered', 'imported', 'tracking')`,
      ),
      check(
        'sessions_context_inheritance_check',
        sql`${t.contextInheritance} IS NULL OR ${t.contextInheritance} IN ('parent-history', 'none')`,
      ),
    ],
    postgres: (t) => [
      pgUniqueIndex('uniq_sessions_source_adapter_session_id').on(t.source, t.adapterSessionId),
      pgUniqueIndex('uniq_sessions_log_file_path').on(t.logFilePath),
      pgIndex('sessions_adapter_session_id_idx').on(t.adapterSessionId),
      pgIndex('idx_sessions_import_status').on(t.importStatus),
      pgIndex('sessions_execution_target_id_idx').on(t.executionTargetId),
      pgIndex('idx_sessions_parent_session_id').on(t.parentSessionId),
      pgCheck(
        'sessions_import_status_check',
        sql`${t.importStatus} IS NULL OR ${t.importStatus} IN ('discovered', 'imported', 'tracking')`,
      ),
      pgCheck(
        'sessions_context_inheritance_check',
        sql`${t.contextInheritance} IS NULL OR ${t.contextInheritance} IN ('parent-history', 'none')`,
      ),
    ],
  },
);

/** SQLite face of the `sessions` table (canonical schema). */
export const sessions = sessionsDual.sqlite;

/**
 * Agents table schema.
 *
 * Persistent agent state. The agent is a stable identity shell;
 * the connector is ephemeral and recreated on startup.
 *
 * Replaces the former `session_agents` join table. The relationship
 * between agent and session is 1:1, modeled via session_id FK.
 */
export const agentsDual = defineDualTable(
  'agents',
  (c) => ({
    /** Unique agent identifier (stable across connector swaps and restarts) */
    agentId: c.text('agent_id').primaryKey(),

    /** Adapter instance that owns this agent */
    adapterId: c.text('adapter_id').notNull(),

    /** Adapter type name (e.g., 'claude-code', 'gemini-sdk') */
    adapterName: c.text('adapter_name').notNull(),

    /** Makaio session this agent belongs to */
    sessionId: c
      .text('session_id')
      .notNull()
      .references(() => sessionsDual.columnPair('sessionId'), { onDelete: 'cascade' }),

    /** Provider's session ID for native resume support */
    adapterSessionId: c.text('adapter_session_id'),

    /** Current model identifier */
    model: c.text('model'),

    /** Current working directory */
    cwd: c.text('cwd'),

    /** Provider config UUID for credential/endpoint resolution */
    providerConfigId: c.text('provider_config_id'),

    /** Persona used to configure this agent (if any). */
    personaId: c.text('persona_id'),

    /** Profile used to configure this agent (if any). */
    profileId: c.text('profile_id'),

    /** Resolved harness ID for this agent. */
    harnessId: c.text('harness_id'),

    /** Client identifier for the client application this agent runs under (e.g., 'claude-code', 'codex'). */
    clientId: c.text('client_id'),

    /** Resolved compression mode for this agent. */
    compressionMode: c.text('compression_mode'),

    /** Agent role in session */
    role: c.textEnum('role', { enum: ['lead', 'member'] as const }).notNull(),

    /**
     * Agent lifecycle status.
     * - 'idle': Connector ready, no active turn
     * - 'active': Turn in progress
     * - 'dead': Connector lost, awaiting rehydration
     * - 'disposed': Agent replaced (cross-adapter switch) — retained for message metadata
     */
    status: c.textEnum('status', { enum: ['idle', 'active', 'dead', 'disposed'] as const }).notNull(),

    /** Timestamp when agent was created (= when added to session) */
    createdAt: c.epochMs('created_at').notNull(),

    /** Timestamp of last activity (message sent/received) */
    lastActivityAt: c.epochMs('last_activity_at').notNull(),
  }),
  {
    sqlite: (t) => [
      index('agents_session_id_idx').on(t.sessionId),
      index('agents_adapter_name_idx').on(t.adapterName),
      index('agents_status_idx').on(t.status),
      index('agents_client_id_idx').on(t.clientId),
    ],
    postgres: (t) => [
      pgIndex('agents_session_id_idx').on(t.sessionId),
      pgIndex('agents_adapter_name_idx').on(t.adapterName),
      pgIndex('agents_status_idx').on(t.status),
      pgIndex('agents_client_id_idx').on(t.clientId),
    ],
  },
);

/** SQLite face of the `agents` table (canonical schema). */
export const agents = agentsDual.sqlite;

/**
 * Type for inserting a new session.
 */
export type InsertSession = typeof sessions.$inferInsert;

/**
 * Type for a selected session row.
 */
export type SelectSession = typeof sessions.$inferSelect;

/**
 * Type for inserting a new agent.
 */
export type InsertAgent = typeof agents.$inferInsert;

/**
 * Type for a selected agent row.
 */
export type SelectAgent = typeof agents.$inferSelect;
