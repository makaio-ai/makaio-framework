import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { ROOT_SESSION_LINEAGE_KIND, SESSION_LINEAGE_KINDS } from '@makaio/contracts/adapter/schemas/session-lineage';
import { sessions } from '../storage/schema.js';

/**
 * Adapter sessions table schema.
 *
 * Tracks sessions discovered from external adapter logs (e.g., Claude Code).
 * Stores lineage information with soft parent references that resolve
 * when all sessions in a fork chain are imported.
 */
export const adapterSessions = sqliteTable(
  'adapter_sessions',
  {
    /**
     * Adapter's session ID (primary key).
     * For Claude Code, this is the sessionId from the last user message in the log.
     */
    adapterSessionId: text('adapter_session_id').primaryKey(),

    /**
     * Adapter type name (e.g., 'claude-code').
     */
    adapterName: text('adapter_name').notNull(),

    /**
     * Parent session's adapter ID (soft reference).
     * May reference a session not yet imported - resolves when parent is imported.
     * NULL for root sessions (no parent).
     */
    parentAdapterSessionId: text('parent_adapter_session_id'),

    /**
     * adapterMessageId of the fork point.
     * The first user message that originated in this session (after inherited content).
     * NULL for root sessions.
     */
    forkPointMessageId: text('fork_point_message_id'),

    /**
     * Makaio session ID (foreign key).
     * Created by the handler when processing session.discovered.
     * May be NULL if session record not yet created.
     */
    sessionId: text('session_id').references(() => sessions.sessionId),

    /**
     * Model used in this session (if known from logs).
     */
    model: text('model'),

    /**
     * Working directory (if known from logs).
     */
    cwd: text('cwd'),

    /**
     * Absolute path to the source log file on disk (if known from logs).
     */
    logFilePath: text('log_file_path'),

    /**
     * Relationship of this session to its parent.
     * - 'root': No parent (standalone session)
     * - 'fork': User-initiated fork from a parent session
     * - 'subagent': Spawned programmatically by a parent agent
     */
    kind: text('kind', { enum: SESSION_LINEAGE_KINDS }).notNull().default(ROOT_SESSION_LINEAGE_KIND),

    /**
     * Timestamp when this session was discovered.
     * Stored as Unix timestamp in milliseconds.
     */
    discoveredAt: integer('discovered_at').notNull(),

    /**
     * Timestamp when the adapter session started (first message).
     * Stored as Unix timestamp in milliseconds.
     * Defaults to discoveredAt for historical rows where the precise start is unknown.
     *
     * No index on this column yet — the list handler fetches all rows without
     * pagination, so the sort cost is negligible for current data volumes.
     * Add an index when pagination or filtered queries on startedAt are introduced.
     */
    startedAt: integer('started_at').notNull(),

    /**
     * Session status.
     * - 'discovered': Found in logs, not fully imported yet
     * - 'imported': All messages imported
     * - 'live': Created by Makaio (not imported)
     * - 'tracking': Imported but source file is still actively being written to
     */
    status: text('status', { enum: ['discovered', 'imported', 'live', 'tracking'] })
      .notNull()
      .default('discovered'),
  },
  (table) => [
    /**
     * Index for efficient log file path lookups.
     * Used when resolving an adapter session by its source log file path
     * (e.g., for cursor writing after a full import via importFromFileContent).
     */
    uniqueIndex('uniq_adapter_sessions_log_file_path').on(table.logFilePath),
  ],
);

/**
 * Type for inserting a new adapter session.
 */
export type InsertAdapterSession = typeof adapterSessions.$inferInsert;

/**
 * Type for a selected adapter session row.
 */
export type SelectAdapterSession = typeof adapterSessions.$inferSelect;
