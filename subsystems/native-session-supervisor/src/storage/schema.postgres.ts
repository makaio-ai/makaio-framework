/**
 * Postgres twin schema for native session supervisor runtime storage.
 *
 * Each table definition here is the Postgres counterpart of the canonical
 * SQLite table in `schema.ts`. Column names, index names, and row shapes are
 * structurally identical; only the underlying column builders differ.
 *
 * SCHEMA CHANGE WORKFLOW
 * ======================
 * 1. Mirror every change made to schema.ts in this file.
 * 2. Run: `yarn workspace @makaio/storage-migrations db:generate`
 * 3. Review generated SQL in storage/migrations/drizzle-postgres/
 * 4. Migrations auto-apply on startup via runtimes/node (Postgres path).
 */

import { pgTable, text, integer, index } from 'drizzle-orm/pg-core';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';

/**
 * Postgres twin of the supervisor runtimes table.
 *
 * Each row represents a single supervised native process runtime.
 * `supervisor_session_id` is the canonical primary key; `session_id` and
 * `adapter_session_id` are secondary correlation fields used for lookups
 * across the adapter and framework session boundaries.
 */
export const supervisorRuntimes = pgTable(
  'supervisor_runtimes',
  {
    /**
     * Supervisor-assigned session ID.
     * Primary key — canonical runtime identity, never changes after creation.
     */
    supervisorSessionId: text('supervisor_session_id').primaryKey(),

    /**
     * Stable client package identifier (e.g. `'claude-code'`).
     */
    clientId: text('client_id').notNull(),

    /**
     * OS process ID of the spawned process.
     * NULL when the process has exited or is unknown.
     */
    pid: integer('pid'),

    /**
     * Current lifecycle status.
     * One of: 'running' | 'stopped' | 'exited' | 'unknown'
     */
    status: text('status', { enum: ['running', 'stopped', 'exited', 'unknown'] }).notNull(),

    /**
     * Working directory the process was launched with.
     */
    cwd: text('cwd').notNull(),

    /**
     * Executable command that was run.
     */
    command: text('command').notNull(),

    /**
     * JSON-serialized argument list (`string[]`).
     * Stored as plain `text` — the handler stringifies and parses manually;
     * jsonb would double-encode the value.
     */
    argsJson: text('args_json').notNull(),

    /**
     * JSON-serialized extra environment variables (`Record<string, string>`).
     * NULL when no extra env was provided at launch.
     * Stored as plain `text` — see `args_json` note above.
     */
    envJson: text('env_json'),

    /**
     * Makaio framework session ID, if the runtime was linked to a session.
     */
    sessionId: text('session_id'),

    /**
     * Adapter-assigned session ID, if available.
     */
    adapterSessionId: text('adapter_session_id'),

    /**
     * Unix epoch timestamp (milliseconds) when the process was started.
     */
    startedAt: epochMs('started_at').notNull(),

    /**
     * Unix epoch timestamp (milliseconds) when the process stopped.
     * NULL while the process is still running.
     */
    stoppedAt: epochMs('stopped_at'),

    /**
     * JSON-serialized arbitrary pass-through metadata (`Record<string, unknown>`).
     * NULL when no metadata was provided.
     * Stored as plain `text` — see `args_json` note above.
     */
    metadataJson: text('metadata_json'),
  },
  (table) => [
    /**
     * Index for efficient lookups by framework session ID.
     */
    index('supervisor_runtimes_session_id_idx').on(table.sessionId),

    /**
     * Index for efficient lookups by adapter session ID.
     */
    index('supervisor_runtimes_adapter_session_id_idx').on(table.adapterSessionId),

    /**
     * Index for efficient status-based filtering.
     */
    index('supervisor_runtimes_status_idx').on(table.status),
  ],
);
