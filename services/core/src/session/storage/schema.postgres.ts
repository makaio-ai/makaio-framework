/**
 * Postgres twin schema for session storage tables.
 *
 * Congruent twin of `schema.ts` — identical SQL names, column types mapped to
 * Postgres equivalents via the shared column bundles. Row types are exclusively
 * owned by the canonical `schema.ts`; this file exports table objects only.
 */
import { sql } from 'drizzle-orm';
import { pgTable, text, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { epochMs, bool } from '@makaio/storage-drizzle/columns/postgres';

/** Postgres twin of the `sessions` table. */
export const sessions = pgTable(
  'sessions',
  {
    /** Unique session identifier. Primary key, referenced by agents. */
    sessionId: text('session_id').primaryKey(),

    /** Timestamp when the session was created (Unix ms). */
    createdAt: epochMs('created_at').notNull(),

    /** Timestamp of last activity in the session (Unix ms). */
    lastActivityAt: epochMs('last_activity_at').notNull(),

    /**
     * Current session status.
     * - 'active': Session is open and accepting activity
     * - 'closed': Session has been terminated
     * - 'archived': Session is hidden from default views, pending purge
     * - 'discovered': Stub from log discovery; full import not yet done
     */
    status: text('status', { enum: ['active', 'closed', 'archived', 'discovered'] }).notNull(),

    /** Lead agent ID (receives messages by default). */
    leadAgentId: text('lead_agent_id'),

    /** Parent session ID for forked sessions. */
    parentSessionId: text('parent_session_id'),

    /** Controls whether a child session inherits parent conversation history. */
    contextInheritance: text('context_inheritance', {
      enum: ['parent-history', 'none'],
    }),

    /** Root session ID for fork chains (denormalized). */
    rootSessionId: text('root_session_id'),

    /** Message ID where this session forked from parent. */
    forkPointMessageId: text('fork_point_message_id'),

    /**
     * Type of branch this session represents.
     * - 'fork' | 'branch' | 'subagent' | 'compress' | 'rewrite' | 'coordinator' | 'aside'
     */
    branchKind: text('branch_kind', {
      enum: ['fork', 'branch', 'subagent', 'compress', 'rewrite', 'coordinator', 'aside'],
    }),

    /** Adapter type name (e.g., 'claude-code', 'codex-mcp'). */
    adapterName: text('adapter_name'),

    /** Provider's session ID. */
    adapterSessionId: text('adapter_session_id'),

    /** Adapter instance ID (machine/installation specific). */
    adapterId: text('adapter_id'),

    /** Client application this session is linked to. */
    clientId: text('client_id'),

    /** Canonical client account linked to this session. */
    clientAccountId: text('client_account_id'),

    /**
     * Latest raw client identity observation persisted for the session.
     * Hand-stringified JSON — stored as plain text, never jsonb.
     */
    lastClientIdentityObservation: text('last_client_identity_observation'),

    /** Whether this session has been modified by Makaio orchestration. */
    isOrchestrated: bool('is_orchestrated').default(false),

    /** Session title for sidebar display. */
    title: text('title'),

    /** Session summary for search and context. */
    summary: text('summary'),

    /** Timestamp when summary was last updated (Unix ms). */
    summaryUpdatedAt: epochMs('summary_updated_at'),

    /** Whether this session was imported from an external source. */
    isImported: bool('is_imported').default(false),

    /**
     * Fork transforms (JSON string).
     * Hand-stringified JSON — stored as plain text, never jsonb.
     */
    forkTransforms: text('fork_transforms'),

    /** Target working directory for this session. */
    targetWorkingDirectory: text('target_working_directory'),

    /** Stamped execution target ID. */
    executionTargetId: text('execution_target_id'),

    /**
     * User-set approval policy override for this session.
     * - 'reject' | 'always-ask' | 'full-access'
     */
    approvalPolicyOverride: text('approval_policy_override', {
      enum: ['reject', 'always-ask', 'full-access'],
    }),

    /** Tool call ID of the spawn_subagent invocation that spawned this session. */
    spawningToolCallId: text('spawning_tool_call_id'),

    // ─── Import provenance fields ───────────────────────────────────────

    /** Identifies the external tool that produced the imported logs. */
    source: text('source'),

    /** Parent session's external ID (soft reference for import lineage). */
    parentExternalSessionId: text('parent_external_session_id'),

    /** Absolute path to the source log file on disk. */
    logFilePath: text('log_file_path'),

    /** Monotonic timestamp (ms) when this session was first discovered during import. */
    discoveredAt: epochMs('discovered_at'),

    /**
     * Import-specific lifecycle status.
     * - 'discovered' | 'imported' | 'tracking'
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
    index('idx_sessions_parent_session_id').on(table.parentSessionId),
    // DB-level CHECK constraints exist exactly where the canonical schema
    // declares them (import_status, context_inheritance). The remaining
    // enum-typed text columns (status, branch_kind, approval_policy_override
    // here; role and status on agents) are application-enforced in both
    // dialects, so the twin does not add Postgres-only constraints — DDL
    // parity with the canonical schema takes precedence.
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

/** Postgres twin of the `agents` table. */
export const agents = pgTable(
  'agents',
  {
    /** Unique agent identifier (stable across connector swaps and restarts). */
    agentId: text('agent_id').primaryKey(),

    /** Adapter instance that owns this agent. */
    adapterId: text('adapter_id').notNull(),

    /** Adapter type name (e.g., 'claude-code', 'gemini-sdk'). */
    adapterName: text('adapter_name').notNull(),

    /** Makaio session this agent belongs to. */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),

    /** Provider's session ID for native resume support. */
    adapterSessionId: text('adapter_session_id'),

    /** Current model identifier. */
    model: text('model'),

    /** Current working directory. */
    cwd: text('cwd'),

    /** Provider config UUID for credential/endpoint resolution. */
    providerConfigId: text('provider_config_id'),

    /** Persona used to configure this agent (if any). */
    personaId: text('persona_id'),

    /** Profile used to configure this agent (if any). */
    profileId: text('profile_id'),

    /** Resolved harness ID for this agent. */
    harnessId: text('harness_id'),

    /** Client identifier for the client application this agent runs under. */
    clientId: text('client_id'),

    /** Resolved compression mode for this agent. */
    compressionMode: text('compression_mode'),

    /**
     * Agent role in session.
     * Enum is application-enforced in both dialects — see the check-constraint
     * note on the sessions table; the same applies to `status` below.
     */
    role: text('role', { enum: ['lead', 'member'] }).notNull(),

    /**
     * Agent lifecycle status.
     * - 'idle' | 'active' | 'dead' | 'disposed'
     */
    status: text('status', { enum: ['idle', 'active', 'dead', 'disposed'] }).notNull(),

    /** Timestamp when agent was created (Unix ms). */
    createdAt: epochMs('created_at').notNull(),

    /** Timestamp of last activity (Unix ms). */
    lastActivityAt: epochMs('last_activity_at').notNull(),
  },
  (table) => [
    index('agents_session_id_idx').on(table.sessionId),
    index('agents_adapter_name_idx').on(table.adapterName),
    index('agents_status_idx').on(table.status),
    index('agents_client_id_idx').on(table.clientId),
  ],
);
