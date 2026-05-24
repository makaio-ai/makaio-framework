import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';

/**
 * Sessions table schema.
 *
 * Stores makaio orchestration sessions. Each session represents a logical
 * conversation context that may span multiple agents and adapters.
 *
 * SEAM: The `sessionId` column is the primary key that extensions can
 * reference for their own decorator tables (e.g., `extension_chat_messages`).
 */
export const sessions = sqliteTable(
  'sessions',
  {
    /**
     * Unique session identifier.
     * Primary key, referenced by agents and future plugin tables.
     */
    sessionId: text('session_id').primaryKey(),

    /**
     * Timestamp when the session was created.
     * Stored as Unix timestamp in milliseconds.
     */
    createdAt: integer('created_at').notNull(),

    /**
     * Timestamp of last activity in the session.
     * Stored as Unix timestamp in milliseconds.
     */
    lastActivityAt: integer('last_activity_at').notNull(),

    /**
     * Current session status.
     * - 'active': Session is open and accepting activity
     * - 'closed': Session has been terminated
     * - 'archived': Session is hidden from default views, pending purge
     * - 'discovered': Stub from log discovery; full import not yet done
     */
    status: text('status', { enum: ['active', 'closed', 'archived', 'discovered'] }).notNull(),

    /**
     * Lead agent ID (receives messages by default).
     * Null if no agents have been added yet.
     */
    leadAgentId: text('lead_agent_id'),

    /**
     * Parent session ID for forked sessions.
     * Null for root sessions.
     */
    parentSessionId: text('parent_session_id'),

    /**
     * Controls whether a child session inherits parent conversation history.
     * Null preserves legacy behavior for existing sessions.
     */
    contextInheritance: text('context_inheritance', {
      enum: ['parent-history', 'none'],
    }),

    /**
     * Root session ID for fork chains.
     * Denormalized for efficient "find all sessions in family" queries.
     * Null for root sessions (they ARE the root).
     */
    rootSessionId: text('root_session_id'),

    /**
     * Message ID where this session forked from parent.
     * The last message that was copied from parent to this fork.
     * Null for root sessions.
     */
    forkPointMessageId: text('fork_point_message_id'),

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
    branchKind: text('branch_kind', {
      enum: ['fork', 'branch', 'subagent', 'compress', 'rewrite', 'coordinator', 'aside'],
    }),

    /**
     * Adapter type name (e.g., 'claude-code', 'codex-mcp').
     * Identifies the source adapter for native imports.
     */
    adapterName: text('adapter_name'),

    /**
     * Provider's session ID.
     * For native imports, this is the external tool's session identifier.
     */
    adapterSessionId: text('adapter_session_id'),

    /**
     * Adapter instance ID (machine/installation specific).
     * Used to determine if native resume is possible.
     */
    adapterId: text('adapter_id'),

    /**
     * Client application this session is linked to (for example `claude-code`).
     */
    clientId: text('client_id'),

    /**
     * Canonical client account linked to this session.
     */
    clientAccountId: text('client_account_id'),

    /**
     * Latest raw client identity observation persisted for the session.
     * Stored as a JSON string.
     */
    lastClientIdentityObservation: text('last_client_identity_observation'),

    /**
     * Whether this session has been modified by Makaio orchestration.
     * False = native session, can use adapter's native resume.
     * True = Makaio modified history, must inject context.
     */
    isOrchestrated: integer('is_orchestrated', { mode: 'boolean' }).default(false),

    /**
     * Session title for sidebar display.
     * Generated after conversation develops. NULL until generated.
     */
    title: text('title'),

    /**
     * Session summary for search and context.
     * Generated after conversation develops. NULL until generated.
     */
    summary: text('summary'),

    /**
     * Timestamp when summary was last updated.
     * Used to detect staleness for regeneration.
     */
    summaryUpdatedAt: integer('summary_updated_at'),

    /**
     * Whether this session was imported from external source.
     * - true: Imported (allow incremental re-imports)
     * - false/null: Created by Makaio runtime (skip on import)
     */
    isImported: integer('is_imported', { mode: 'boolean' }).default(false),

    /**
     * Fork transforms (JSON string).
     * Stored on fork sessions for getFullConversation() context projection.
     * Contains removedMessageIds and appliedPipeline configuration.
     */
    forkTransforms: text('fork_transforms'),

    /**
     * Target working directory for this session.
     * Used to override the default working directory for forked sessions.
     */
    targetWorkingDirectory: text('target_working_directory'),

    /**
     * Stamped execution target ID.
     * Set during first startAgent resolution. Null until resolved.
     */
    executionTargetId: text('execution_target_id'),

    /**
     * User-set approval policy override for this session.
     * When set, takes precedence over the persona → profile → harness cascade.
     * Null (default) means "use the cascade defaults".
     */
    approvalPolicyOverride: text('approval_policy_override', {
      enum: ['reject', 'always-ask', 'full-access'],
    }),

    /**
     * Tool call ID of the Agent/spawn_subagent invocation that spawned this session.
     * Only set for subagent sessions. Null for root/fork sessions.
     */
    spawningToolCallId: text('spawning_tool_call_id'),

    // ─── Import provenance fields ───────────────────────────────────────

    /**
     * Identifies the external tool that produced the imported logs.
     * For live sessions this is null; for imports it identifies the source
     * (e.g., 'claude-code', 'codex', 'opencode').
     */
    source: text('source'),

    /**
     * Parent session's external ID (soft reference for import lineage).
     * May reference a session not yet imported — resolves when parent is imported.
     * Null for root sessions or live sessions.
     */
    parentExternalSessionId: text('parent_external_session_id'),

    /**
     * Absolute path to the source log file on disk.
     * Only set for imported sessions. Used for cursor resumption and deduplication.
     */
    logFilePath: text('log_file_path'),

    /**
     * Monotonic timestamp (ms) when this session was first discovered during import.
     * Used for created-detection in upsert logic. Null for live sessions.
     */
    discoveredAt: integer('discovered_at'),

    /**
     * Import-specific lifecycle status. Null for live sessions.
     * - 'discovered': Found in logs, not fully imported yet
     * - 'imported': All messages imported successfully
     * - 'tracking': Imported but source file is still actively being written to
     */
    importStatus: text('import_status', {
      enum: ['discovered', 'imported', 'tracking'],
    }),
  },
  (table) => [
    uniqueIndex('uniq_sessions_source_adapter_session_id').on(table.source, table.adapterSessionId),
    uniqueIndex('uniq_sessions_log_file_path').on(table.logFilePath),
    index('sessions_adapter_session_id_idx').on(table.adapterSessionId),
    index('idx_sessions_import_status').on(table.importStatus),
    index('sessions_execution_target_id_idx').on(table.executionTargetId),
    check(
      'sessions_import_status_check',
      sql`${table.importStatus} IS NULL OR ${table.importStatus} IN ('discovered', 'imported', 'tracking')`,
    ),
    check(
      'sessions_context_inheritance_check',
      sql`${table.contextInheritance} IS NULL OR ${table.contextInheritance} IN ('parent-history', 'none')`,
    ),
  ],
);

/**
 * Agents table schema.
 *
 * Persistent agent state. The agent is a stable identity shell;
 * the connector is ephemeral and recreated on startup.
 *
 * Replaces the former `session_agents` join table. The relationship
 * between agent and session is 1:1, modeled via session_id FK.
 */
export const agents = sqliteTable(
  'agents',
  {
    /** Unique agent identifier (stable across connector swaps and restarts) */
    agentId: text('agent_id').primaryKey(),

    /** Adapter instance that owns this agent */
    adapterId: text('adapter_id').notNull(),

    /** Adapter type name (e.g., 'claude-code', 'gemini-sdk') */
    adapterName: text('adapter_name').notNull(),

    /** Makaio session this agent belongs to */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),

    /** Provider's session ID for native resume support */
    adapterSessionId: text('adapter_session_id'),

    /** Current model identifier */
    model: text('model'),

    /** Current working directory */
    cwd: text('cwd'),

    /** Provider config UUID for credential/endpoint resolution */
    providerConfigId: text('provider_config_id'),

    /** Persona used to configure this agent (if any). */
    personaId: text('persona_id'),

    /** Profile used to configure this agent (if any). */
    profileId: text('profile_id'),

    /** Resolved harness ID for this agent. */
    harnessId: text('harness_id'),

    /** Client identifier for the client application this agent runs under (e.g., 'claude-code', 'codex'). */
    clientId: text('client_id'),

    /** Resolved compression mode for this agent. */
    compressionMode: text('compression_mode'),

    /** Agent role in session */
    role: text('role', { enum: ['lead', 'member'] }).notNull(),

    /**
     * Agent lifecycle status.
     * - 'idle': Connector ready, no active turn
     * - 'active': Turn in progress
     * - 'dead': Connector lost, awaiting rehydration
     * - 'disposed': Agent replaced (cross-adapter switch) — retained for message metadata
     */
    status: text('status', { enum: ['idle', 'active', 'dead', 'disposed'] }).notNull(),

    /** Timestamp when agent was created (= when added to session) */
    createdAt: integer('created_at').notNull(),

    /** Timestamp of last activity (message sent/received) */
    lastActivityAt: integer('last_activity_at').notNull(),
  },
  (table) => [
    index('agents_session_id_idx').on(table.sessionId),
    index('agents_adapter_name_idx').on(table.adapterName),
    index('agents_status_idx').on(table.status),
    index('agents_client_id_idx').on(table.clientId),
  ],
);

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
