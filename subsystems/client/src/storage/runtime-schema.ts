/**
 * Drizzle schema for the `client_runtimes` table.
 *
 * Persists metadata and lifecycle status for each observed client runtime
 * instance. The `id` column holds the stable `clientRuntimeId` UUID assigned
 * by the registry. Evidence fields are nullable because they accumulate
 * incrementally across multiple observations.
 * @packageDocumentation
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { epochMs, jsonCol } from '@makaio/storage-drizzle/columns/sqlite';

/**
 * Persistent store for client runtime records.
 *
 * Each row represents one observed client process instance. Rows are created
 * on first observation and enriched as stronger evidence arrives. The registry
 * never deletes rows — termination signals are out of scope for v1.
 */
export const clientRuntimes = sqliteTable(
  'client_runtimes',
  {
    /** Stable runtime identifier (UUID v4) assigned by the registry. */
    id: text('id').primaryKey(),

    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: text('client_id').notNull(),

    /**
     * Lifecycle status of the runtime.
     * Either `'observed'` (weak evidence) or `'started'` (strong evidence).
     */
    status: text('status').notNull(),

    /** Supervisor-assigned session ID, when the supervisor detected the runtime. */
    supervisorSessionId: text('supervisor_session_id'),

    /** OS process ID of the client binary. */
    pid: integer('pid'),

    /** OS process ID of the parent process. */
    parentPid: integer('parent_pid'),

    /** Raw session identifier from the client runtime. */
    adapterSessionId: text('adapter_session_id'),

    /** Framework session ID, if already resolved at observation time. */
    sessionId: text('session_id'),

    /** Working directory of the client process. */
    cwd: text('cwd'),

    /** Full argv of the client process as a JSON array. */
    argv: jsonCol<string[]>('argv'),

    /** Arbitrary pass-through metadata from the most recent observation. */
    metadata: jsonCol<Record<string, unknown>>('metadata'),

    /** Unix epoch timestamp in milliseconds of the latest captured observation while the row was observed. */
    observedAt: epochMs('observed_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this record was created. */
    createdAt: epochMs('created_at').notNull(),

    /** Unix epoch timestamp in milliseconds of the last mutation. */
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    index('idx_client_runtimes_supervisor_session_id').on(table.supervisorSessionId),
    index('idx_client_runtimes_pid_client_id').on(table.pid, table.clientId),
    index('idx_client_runtimes_adapter_session_id_client_id').on(table.adapterSessionId, table.clientId),
  ],
);

/** Inferred insert type for the `client_runtimes` table. */
export type InsertClientRuntime = typeof clientRuntimes.$inferInsert;

/** Inferred select type for the `client_runtimes` table. */
export type SelectClientRuntime = typeof clientRuntimes.$inferSelect;
