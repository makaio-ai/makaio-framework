/**
 * Drizzle schema for native session supervisor runtime storage.
 *
 * Stores persistent metadata about supervised native process runtimes.
 * Scrollback and terminal output are NOT stored here — only lifecycle
 * metadata and correlation identifiers.
 *
 * SCHEMA CHANGE WORKFLOW
 * ======================
 * 1. Modify the schema file(s) in src/storage/schema.ts
 * 2. Run: `yarn workspace \@makaio/storage-migrations db:generate`
 * 3. Review generated SQL in storage/migrations/drizzle/
 * 4. Migrations auto-apply on startup via runtimes/node
 */

import { index } from 'drizzle-orm/sqlite-core';
import { index as pgIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Supervisor runtimes table.
 *
 * Each row represents a single supervised native process runtime.
 * `supervisor_session_id` is the canonical primary key; `session_id` and
 * `adapter_session_id` are secondary correlation fields used for lookups
 * across the adapter and framework session boundaries.
 */
export const supervisorRuntimesDual = defineDualTable(
  'supervisor_runtimes',
  (c) => ({
    /**
     * Supervisor-assigned session ID.
     * Primary key — canonical runtime identity, never changes after creation.
     */
    supervisorSessionId: c.text('supervisor_session_id').primaryKey(),

    /**
     * Stable client package identifier (e.g. `'claude-code'`).
     */
    clientId: c.text('client_id').notNull(),

    /**
     * OS process ID of the spawned process.
     * NULL when the process has exited or is unknown.
     */
    pid: c.int4('pid'),

    /**
     * Current lifecycle status.
     * One of: 'running' | 'stopped' | 'exited' | 'unknown'
     */
    status: c.textEnum('status', { enum: ['running', 'stopped', 'exited', 'unknown'] as const }).notNull(),

    /**
     * Working directory the process was launched with.
     */
    cwd: c.text('cwd').notNull(),

    /**
     * Executable command that was run.
     */
    command: c.text('command').notNull(),

    /**
     * JSON-serialized argument list (`string[]`).
     * Stored as plain `text` — the handler stringifies and parses manually;
     * jsonb would double-encode the value.
     */
    argsJson: c.text('args_json').notNull(),

    /**
     * JSON-serialized extra environment variables (`Record<string, string>`).
     * NULL when no extra env was provided at launch.
     * Stored as plain `text` — see `args_json` note above.
     */
    envJson: c.text('env_json'),

    /**
     * Makaio framework session ID, if the runtime was linked to a session.
     */
    sessionId: c.text('session_id'),

    /**
     * Adapter-assigned session ID, if available.
     */
    adapterSessionId: c.text('adapter_session_id'),

    /**
     * Unix epoch timestamp (milliseconds) when the process was started.
     */
    startedAt: c.epochMs('started_at').notNull(),

    /**
     * Unix epoch timestamp (milliseconds) when the process stopped.
     * NULL while the process is still running.
     */
    stoppedAt: c.epochMs('stopped_at'),

    /**
     * JSON-serialized arbitrary pass-through metadata (`Record<string, unknown>`).
     * NULL when no metadata was provided.
     * Stored as plain `text` — see `args_json` note above.
     */
    metadataJson: c.text('metadata_json'),
  }),
  {
    sqlite: (t) => [
      /**
       * Index for efficient lookups by framework session ID.
       */
      index('supervisor_runtimes_session_id_idx').on(t.sessionId),

      /**
       * Index for efficient lookups by adapter session ID.
       */
      index('supervisor_runtimes_adapter_session_id_idx').on(t.adapterSessionId),

      /**
       * Index for efficient status-based filtering.
       */
      index('supervisor_runtimes_status_idx').on(t.status),
    ],
    postgres: (t) => [
      /**
       * Index for efficient lookups by framework session ID.
       */
      pgIndex('supervisor_runtimes_session_id_idx').on(t.sessionId),

      /**
       * Index for efficient lookups by adapter session ID.
       */
      pgIndex('supervisor_runtimes_adapter_session_id_idx').on(t.adapterSessionId),

      /**
       * Index for efficient status-based filtering.
       */
      pgIndex('supervisor_runtimes_status_idx').on(t.status),
    ],
  },
);

/** SQLite face of the `supervisor_runtimes` table (canonical schema). */
export const supervisorRuntimes = supervisorRuntimesDual.sqlite;

/**
 * Type for a full supervisor runtime row selected from the database.
 */
export type SelectSupervisorRuntime = typeof supervisorRuntimes.$inferSelect;

/**
 * Type for inserting a new supervisor runtime row.
 */
export type InsertSupervisorRuntime = typeof supervisorRuntimes.$inferInsert;
