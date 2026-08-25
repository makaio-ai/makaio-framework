import { sql } from 'drizzle-orm';
import { index, uniqueIndex, check, foreignKey, primaryKey } from 'drizzle-orm/sqlite-core';
import {
  index as pgIndex,
  uniqueIndex as pgUniqueIndex,
  check as pgCheck,
  foreignKey as pgForeignKey,
  primaryKey as pgPrimaryKey,
} from 'drizzle-orm/pg-core';
import type { JsonValue } from '@makaio/contracts';
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
     * Provider's session ID — the **immutable origin identity**.
     *
     * For native imports this is the external tool's session identifier and
     * the conflict key of `uniq_sessions_source_adapter_session_id`. Write-once
     * by contract: it records where the session came from, never where the
     * provider session moved to. Resume callers read the currency pair below.
     */
    adapterSessionId: c.text('adapter_session_id'),

    /**
     * Provider-confirmed session ID that currently carries the conversation.
     *
     * Meaningful only while `currentAdapterSessionIdState` is `'confirmed'`.
     * Deliberately not part of any unique index: unlike the origin identity it
     * moves, so it is not an identity key.
     */
    currentAdapterSessionId: c.text('current_adapter_session_id'),

    /**
     * Currency state of the provider-native resume identity.
     * - 'inherited': never moved; `adapterSessionId` is the valid currency
     * - 'moved': moved without provider confirmation; nothing is resumable
     * - 'confirmed': `currentAdapterSessionId` is the valid currency
     *
     * Defaulted so pre-existing rows and imports read as `'inherited'` without
     * a backfill pass.
     */
    currentAdapterSessionIdState: c
      .textEnum('current_adapter_session_id_state', {
        enum: ['inherited', 'moved', 'confirmed'] as const,
      })
      .notNull()
      .default('inherited'),

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
     * Opaque consumer-owned JSON metadata.
     *
     * The framework preserves this data but never interprets its keys.
     */
    metadata: c.jsonCol<Record<string, JsonValue>>('metadata'),

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

    /**
     * Whether the external tool marked this session as a sidechain/subagent
     * perspective. NULL = unknown/live session; only imports populate it.
     */
    isSidechain: c.bool('is_sidechain'),

    /**
     * Stable runtime machine identity that owns the provider-native session store.
     *
     * Caller-supplied by the owning hook/runtime — never derived from the writer
     * process so that central or downstream servers can import foreign sessions
     * without stamping their own machine ID.
     */
    machineId: c.text('machine_id'),
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
      check(
        'sessions_current_adapter_session_id_currency_check',
        sql`${t.currentAdapterSessionIdState} IN ('inherited', 'moved', 'confirmed') AND (${t.currentAdapterSessionIdState} <> 'confirmed' OR ${t.currentAdapterSessionId} IS NOT NULL) AND (${t.currentAdapterSessionIdState} = 'confirmed' OR ${t.currentAdapterSessionId} IS NULL)`,
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
      // Emitted by drizzle-kit as a plain validating `ALTER TABLE ... ADD
      // CONSTRAINT`, not as `NOT VALID` followed by `VALIDATE CONSTRAINT`. The
      // two-step form exists to avoid a long ACCESS EXCLUSIVE lock while an
      // existing table is scanned, which does not apply here: the constraint
      // lands in the same generated migration that adds both columns, so every
      // row it validates was just created with the default `'inherited'` /
      // `NULL` pair and the scan is trivially satisfiable. Splitting it is also
      // not expressible through `pgCheck` — it would require hand-editing a
      // landed migration file, and `readMigrations` hashes raw SQL as ledger
      // identity, so editing it would orphan every provisioned database.
      pgCheck(
        'sessions_current_adapter_session_id_currency_check',
        sql`${t.currentAdapterSessionIdState} IN ('inherited', 'moved', 'confirmed') AND (${t.currentAdapterSessionIdState} <> 'confirmed' OR ${t.currentAdapterSessionId} IS NOT NULL) AND (${t.currentAdapterSessionIdState} = 'confirmed' OR ${t.currentAdapterSessionId} IS NULL)`,
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

    /** Machine hosting the current live connector, when one has been committed. */
    ownerMachineId: c.text('owner_machine_id'),

    /** Runtime incarnation hosting the current live connector. */
    ownerInstanceId: c.text('owner_instance_id'),

    /** Opaque fence for the recovery attempt currently driving this agent. */
    recoveryAttemptId: c.text('recovery_attempt_id'),

    /**
     * Provider's session ID — this agent's **immutable origin identity**.
     *
     * Records which provider session the agent started from, never where that
     * conversation moved to. The currency pair below carries the movement.
     */
    adapterSessionId: c.text('adapter_session_id'),

    /**
     * Provider-confirmed session ID that currently carries this agent's
     * conversation.
     *
     * Meaningful only while `currentAdapterSessionIdState` is `'confirmed'`.
     * Mirrors the sessions row's currency pair, and like it is deliberately not
     * part of any unique index: it moves, so it is not an identity key.
     */
    currentAdapterSessionId: c.text('current_adapter_session_id'),

    /**
     * Currency state of this agent's provider-native resume identity.
     * - 'inherited': never moved; `adapterSessionId` is the valid currency
     * - 'moved': moved without provider confirmation; nothing is resumable
     * - 'confirmed': `currentAdapterSessionId` is the valid currency
     *
     * Defaulted so pre-existing rows read as `'inherited'` without a backfill.
     */
    currentAdapterSessionIdState: c
      .textEnum('current_adapter_session_id_state', {
        enum: ['inherited', 'moved', 'confirmed'] as const,
      })
      .notNull()
      .default('inherited'),

    /**
     * Compare-and-swap revision of this agent's currency.
     *
     * Bumped exclusively by the session-ownership storage seam: a settle passes
     * the revision it read, and the write only lands while the row still carries
     * it. That is what totally orders two currency writes issued inside one
     * claim generation. Any other writer bumping it would make the swap fail for
     * reasons unrelated to currency, which is the same as not having it.
     */
    revision: c.int4('revision').notNull().default(0),

    /**
     * Fence of the claim generation that last wrote this agent's currency.
     *
     * Zero while the currency has never been written. Claim generations are
     * totally ordered by fence, so a settle carrying a lower fence is a stale
     * owner from a superseded generation and is refused. Persisting the fence
     * here — rather than only on the claim row — is what makes that refusal
     * survive the claim being taken over, released, or re-taken.
     */
    currencyFence: c.int4('currency_fence').notNull().default(0),

    /** Current model identifier */
    model: c.text('model'),

    /** Current working directory */
    cwd: c.text('cwd'),

    /** Directory restrictions for file-system tool execution. */
    allowedDirectories: c.jsonCol<string[]>('allowed_directories'),

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
     * - 'starting': Start in flight; the row exists but no connector is confirmed
     * - 'idle': Connector ready, no active turn
     * - 'active': Turn in progress
     * - 'dead': Connector lost, awaiting rehydration
     * - 'disposed': Agent replaced (cross-adapter switch) — retained for message metadata
     *
     * Stored as plain text on both dialects: the enum narrows the inferred TypeScript
     * union, it is not a database constraint, so widening the set needs no DDL.
     */
    status: c.textEnum('status', { enum: ['starting', 'idle', 'active', 'dead', 'disposed'] as const }).notNull(),

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
      check(
        'agents_current_adapter_session_id_currency_check',
        sql`${t.currentAdapterSessionIdState} IN ('inherited', 'moved', 'confirmed') AND (${t.currentAdapterSessionIdState} <> 'confirmed' OR ${t.currentAdapterSessionId} IS NOT NULL) AND (${t.currentAdapterSessionIdState} = 'confirmed' OR ${t.currentAdapterSessionId} IS NULL)`,
      ),
      check('agents_ownership_counters_check', sql`${t.revision} >= 0 AND ${t.currencyFence} >= 0`),
      check('agents_runtime_owner_pair_check', sql`(${t.ownerMachineId} IS NULL) = (${t.ownerInstanceId} IS NULL)`),
    ],
    postgres: (t) => [
      pgIndex('agents_session_id_idx').on(t.sessionId),
      pgIndex('agents_adapter_name_idx').on(t.adapterName),
      pgIndex('agents_status_idx').on(t.status),
      pgIndex('agents_client_id_idx').on(t.clientId),
      // Same validating single-step ALTER rationale as the sessions row's
      // currency check above: both columns and the constraint land in one
      // generated migration, so every row validated by the scan was just created
      // with the default `'inherited'` / `NULL` pair.
      pgCheck(
        'agents_current_adapter_session_id_currency_check',
        sql`${t.currentAdapterSessionIdState} IN ('inherited', 'moved', 'confirmed') AND (${t.currentAdapterSessionIdState} <> 'confirmed' OR ${t.currentAdapterSessionId} IS NOT NULL) AND (${t.currentAdapterSessionIdState} = 'confirmed' OR ${t.currentAdapterSessionId} IS NULL)`,
      ),
      pgCheck('agents_ownership_counters_check', sql`${t.revision} >= 0 AND ${t.currencyFence} >= 0`),
      pgCheck('agents_runtime_owner_pair_check', sql`(${t.ownerMachineId} IS NULL) = (${t.ownerInstanceId} IS NULL)`),
    ],
  },
);

/** SQLite face of the `agents` table (canonical schema). */
export const agents = agentsDual.sqlite;

/**
 * Per-machine runtime incarnation allocation state.
 *
 * This private coordination table serializes incarnation allocation before a
 * runtime instance row is inserted. Its value is never exposed as a public
 * storage record; `runtime_instances` remains the durable audit surface.
 */
export const runtimeInstanceIncarnationCountersDual = defineDualTable('runtime_instance_incarnation_counters', (c) => ({
  /** Machine whose runtime incarnations this row allocates. */
  machineId: c.text('machine_id').primaryKey(),
  /** Last incarnation allocated for this machine. */
  lastAllocatedIncarnation: c.int4('last_allocated_incarnation').notNull(),
}));

/** SQLite face of the private runtime-incarnation counter table. */
export const runtimeInstanceIncarnationCounters = runtimeInstanceIncarnationCountersDual.sqlite;

/**
 * Runtime processes that have taken ownership claims.
 *
 * Rows are retained permanently: `retired_at` is the durable liveness fact;
 * deleting a row would erase the evidence needed to assess its claims.
 */
export const runtimeInstancesDual = defineDualTable(
  'runtime_instances',
  (c) => ({
    /** Identity minted once per runtime process. */
    instanceId: c.text('instance_id').notNull(),
    /** Machine this process acted for. */
    machineId: c.text('machine_id').notNull(),
    /** Storage-allocated, strictly increasing sequence per machine. */
    incarnation: c.int4('incarnation').notNull(),
    /** When this process first took a claim for this machine. */
    startedAt: c.epochMs('started_at').notNull(),
    /** When the process retired itself; null while it may still be running. */
    retiredAt: c.epochMs('retired_at'),
  }),
  {
    sqlite: (t) => [
      primaryKey({ columns: [t.instanceId, t.machineId] }),
      uniqueIndex('uniq_runtime_instances_incarnation').on(t.machineId, t.incarnation),
    ],
    postgres: (t) => [
      pgPrimaryKey({ columns: [t.instanceId, t.machineId] }),
      pgUniqueIndex('uniq_runtime_instances_incarnation').on(t.machineId, t.incarnation),
    ],
  },
);

/** SQLite face of the `runtime_instances` table (canonical schema). */
export const runtimeInstances = runtimeInstancesDual.sqlite;

/**
 * Adapter session claims table schema.
 *
 * Durable ownership of provider-native sessions: one row means "this agent, on
 * this machine, under this adapter runtime, owns this provider session".
 *
 * The **existence** of a row is the ownership, and
 * `uniq_adapter_session_claims_owner` is what makes ownership exclusive: two
 * runtimes racing to own the same provider thread both attempt an insert against
 * that index, and exactly one can win. Exclusivity is therefore a property of
 * the schema, not of a read-then-write in handler code — which matters because
 * the competing writers may be different processes over the same database, where
 * no in-process guard can help.
 *
 * A clean release deletes the row. `status` exists for the cases where the key
 * must keep blocking: a teardown that is not confirmed (`releasing`) and an owner
 * that failed after dispatching to the provider (`abandoned`). Both keep blocking
 * until an explicit takeover names the row's `claimToken`, which mints a new
 * token and a higher `fence` on the same row. Storage does not judge whether
 * that takeover is legitimate — that is the ownership authority's duty.
 */
export const adapterSessionClaimsDual = defineDualTable(
  'adapter_session_claims',
  (c) => ({
    /** Stable identifier of the claim row. */
    claimId: c.text('claim_id').primaryKey(),

    /** Stable runtime machine identity that owns the provider-native session store. */
    machineId: c.text('machine_id').notNull(),

    /** Adapter runtime instance that owns the provider process. */
    adapterId: c.text('adapter_id').notNull(),

    /**
     * Adapter type name of the owning runtime.
     *
     * Not part of the ownership key and never compared by any handler: it is
     * carried for diagnostics and for readers that would otherwise have to join
     * `agents` to name the adapter. Rejecting a foreign adapter's provider ID —
     * if that is ever wanted — is the ownership authority's duty, not storage's.
     */
    adapterName: c.text('adapter_name').notNull(),

    /** Provider's own session/thread identifier. */
    providerSessionId: c.text('provider_session_id').notNull(),

    /** Session the claiming agent belongs to. */
    sessionId: c
      .text('session_id')
      .notNull()
      .references(() => sessionsDual.columnPair('sessionId'), { onDelete: 'cascade' }),

    /**
     * Agent that owns the provider session under this claim.
     *
     * Cascading on agent deletion is deliberate: a claim is the agent's
     * authority, so an agent that no longer exists must not keep a provider
     * session blocked.
     */
    agentId: c
      .text('agent_id')
      .notNull()
      .references(() => agentsDual.columnPair('agentId'), { onDelete: 'cascade' }),

    /** Runtime process that took this generation, or `null` for a legacy claim. */
    ownerInstanceId: c.text('owner_instance_id'),

    /**
     * Opaque identity of the current claim generation, minted by the claimant.
     *
     * Unique among live claims (`uniq_adapter_session_claims_token`), not
     * merely unique per key: a generation is named once, and `settleCurrency` /
     * `release` resolve authority by looking the token up directly. A caller
     * that reuses a live token across keys therefore fails the write rather
     * than silently authorizing itself against a foreign row. Retired tokens
     * are not remembered — a released row is deleted and a takeover overwrites
     * the superseded token — so single use per attempt is the caller's
     * obligation (see the contract's `claimToken` doc).
     */
    claimToken: c.text('claim_token').notNull(),

    /**
     * Generation counter, totally ordered **per agent**.
     *
     * Allocated strictly above every fence the claiming agent already carries —
     * its `currency_fence`, the fences of all claims it currently holds, and, on
     * a takeover, the superseded row's fence. That is what keeps one agent's
     * generations comparable across its whole lifetime, including while it holds
     * two claims mid-movement.
     *
     * Deliberately *not* monotone per ownership key: a cleanly released key
     * carries no row, so a different agent may re-take it at a lower fence. A
     * key is refused by the absence of the caller's claim row, never by
     * comparing fences across agents.
     *
     * `uniq_adapter_session_claims_agent_fence` states that order as a property
     * of the schema. The allocating statements compute the floor from the
     * agent's own state, which no per-key index constrains: two processes
     * claiming two *different* keys for one agent have nothing to collide on and
     * would otherwise both allocate the same fence, after which a settle from
     * either generation passes the other's guard. Handlers serialize that
     * allocation by locking the agent row; this index is what refuses the
     * duplicate if a path ever forgets to.
     */
    fence: c.int4('fence').notNull(),

    /**
     * Claim lifecycle state.
     * - 'held': a live runtime owns the provider session
     * - 'releasing': teardown started, not confirmed — still blocks
     * - 'abandoned': owner failed after dispatch — still blocks until an
     *   explicit takeover names this row's `claim_token`
     */
    status: c
      .textEnum('status', { enum: ['held', 'releasing', 'abandoned'] as const })
      .notNull()
      .default('held'),

    /** Timestamp when the current generation took the claim. */
    claimedAt: c.epochMs('claimed_at').notNull(),

    /** Timestamp when the claim row last changed. */
    updatedAt: c.epochMs('updated_at').notNull(),
  }),
  {
    sqlite: (t) => [
      uniqueIndex('uniq_adapter_session_claims_owner').on(t.machineId, t.adapterId, t.providerSessionId),
      uniqueIndex('uniq_adapter_session_claims_token').on(t.claimToken),
      uniqueIndex('uniq_adapter_session_claims_agent_fence').on(t.agentId, t.fence),
      index('adapter_session_claims_agent_id_idx').on(t.agentId),
      index('adapter_session_claims_session_id_idx').on(t.sessionId),
      foreignKey({
        columns: [t.ownerInstanceId, t.machineId],
        foreignColumns: [runtimeInstancesDual.sqlite.instanceId, runtimeInstancesDual.sqlite.machineId],
      }).onDelete('restrict'),
      check('adapter_session_claims_status_check', sql`${t.status} IN ('held', 'releasing', 'abandoned')`),
      check('adapter_session_claims_fence_check', sql`${t.fence} >= 1`),
    ],
    postgres: (t) => [
      pgUniqueIndex('uniq_adapter_session_claims_owner').on(t.machineId, t.adapterId, t.providerSessionId),
      pgUniqueIndex('uniq_adapter_session_claims_token').on(t.claimToken),
      pgUniqueIndex('uniq_adapter_session_claims_agent_fence').on(t.agentId, t.fence),
      pgIndex('adapter_session_claims_agent_id_idx').on(t.agentId),
      pgIndex('adapter_session_claims_session_id_idx').on(t.sessionId),
      pgForeignKey({
        columns: [t.ownerInstanceId, t.machineId],
        foreignColumns: [runtimeInstancesDual.postgres.instanceId, runtimeInstancesDual.postgres.machineId],
      }).onDelete('restrict'),
      pgCheck('adapter_session_claims_status_check', sql`${t.status} IN ('held', 'releasing', 'abandoned')`),
      pgCheck('adapter_session_claims_fence_check', sql`${t.fence} >= 1`),
    ],
  },
);

/** SQLite face of the `adapter_session_claims` table (canonical schema). */
export const adapterSessionClaims = adapterSessionClaimsDual.sqlite;

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

/** Type for selecting a runtime instance. */
export type SelectRuntimeInstance = typeof runtimeInstances.$inferSelect;

/**
 * Type for inserting a new adapter session claim.
 */
export type InsertAdapterSessionClaim = typeof adapterSessionClaims.$inferInsert;

/**
 * Type for a selected adapter session claim row.
 */
export type SelectAdapterSessionClaim = typeof adapterSessionClaims.$inferSelect;
