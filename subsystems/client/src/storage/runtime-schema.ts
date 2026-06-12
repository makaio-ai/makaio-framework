/**
 * Drizzle schema for the `client_runtimes` table.
 *
 * Persists metadata and lifecycle status for each observed client runtime
 * instance. The `id` column holds the stable `clientRuntimeId` UUID assigned
 * by the registry. Evidence fields are nullable because they accumulate
 * incrementally across multiple observations.
 * @packageDocumentation
 */

import { index } from 'drizzle-orm/sqlite-core';
import { index as pgIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Persistent store for client runtime records.
 *
 * Each row represents one observed client process instance. Rows are created
 * on first observation and enriched as stronger evidence arrives. The registry
 * never deletes rows — termination signals are out of scope for v1.
 */
export const clientRuntimesDual = defineDualTable(
  'client_runtimes',
  (c) => ({
    /** Stable runtime identifier (UUID v4) assigned by the registry. */
    id: c.text('id').primaryKey(),

    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: c.text('client_id').notNull(),

    /**
     * Lifecycle status of the runtime.
     * Either `'observed'` (weak evidence) or `'started'` (strong evidence).
     */
    status: c.text('status').notNull(),

    /** Supervisor-assigned session ID, when the supervisor detected the runtime. */
    supervisorSessionId: c.text('supervisor_session_id'),

    /** OS process ID of the client binary. */
    pid: c.int4('pid'),

    /** OS process ID of the parent process. */
    parentPid: c.int4('parent_pid'),

    /** Raw session identifier from the client runtime. */
    adapterSessionId: c.text('adapter_session_id'),

    /** Framework session ID, if already resolved at observation time. */
    sessionId: c.text('session_id'),

    /** Working directory of the client process. */
    cwd: c.text('cwd'),

    /** Full argv of the client process as a JSON array. */
    argv: c.jsonCol<string[]>('argv'),

    /** Arbitrary pass-through metadata from the most recent observation. */
    metadata: c.jsonCol<Record<string, unknown>>('metadata'),

    /** Unix epoch timestamp in milliseconds of the latest captured observation while the row was observed. */
    observedAt: c.epochMs('observed_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this record was created. */
    createdAt: c.epochMs('created_at').notNull(),

    /** Unix epoch timestamp in milliseconds of the last mutation. */
    updatedAt: c.epochMs('updated_at').notNull(),
  }),
  {
    sqlite: (t) => [
      index('idx_client_runtimes_supervisor_session_id').on(t.supervisorSessionId),
      index('idx_client_runtimes_pid_client_id').on(t.pid, t.clientId),
      index('idx_client_runtimes_adapter_session_id_client_id').on(t.adapterSessionId, t.clientId),
    ],
    postgres: (t) => [
      pgIndex('idx_client_runtimes_supervisor_session_id').on(t.supervisorSessionId),
      pgIndex('idx_client_runtimes_pid_client_id').on(t.pid, t.clientId),
      pgIndex('idx_client_runtimes_adapter_session_id_client_id').on(t.adapterSessionId, t.clientId),
    ],
  },
);

/** SQLite face of the `client_runtimes` table (canonical schema). */
export const clientRuntimes = clientRuntimesDual.sqlite;

/** Inferred insert type for the `client_runtimes` table. */
export type InsertClientRuntime = typeof clientRuntimes.$inferInsert;

/** Inferred select type for the `client_runtimes` table. */
export type SelectClientRuntime = typeof clientRuntimes.$inferSelect;
