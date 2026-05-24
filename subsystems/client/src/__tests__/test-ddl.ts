/**
 * Shared DDL fixtures for clients-core storage tests.
 *
 * Hand-written DDL mirrors the Drizzle schema files. Keeping it centralized
 * prevents package-level integration tests from drifting away from handler
 * tests while still avoiding the full migration runner in unit test setup.
 * @packageDocumentation
 */

import { sql } from 'drizzle-orm';

/**
 * SQLite DDL statements that create the two client-binary storage tables.
 *
 * Used by both the Drizzle handler tests and the manager integration tests to
 * bootstrap an in-memory database with the correct schema.
 */
export const CLIENT_BINARY_DDL = [
  sql`
    CREATE TABLE IF NOT EXISTS client_binary_versions (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      version TEXT NOT NULL,
      install_path TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (client_id, version)
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS client_binary_state (
      client_id TEXT PRIMARY KEY NOT NULL,
      active_version TEXT,
      updated_at INTEGER NOT NULL
    )
  `,
];

/**
 * SQLite DDL statements that create the client runtime storage table.
 */
export const CLIENT_RUNTIME_DDL = [
  sql`
    CREATE TABLE IF NOT EXISTS client_runtimes (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      status TEXT NOT NULL,
      supervisor_session_id TEXT,
      pid INTEGER,
      parent_pid INTEGER,
      adapter_session_id TEXT,
      session_id TEXT,
      cwd TEXT,
      argv TEXT,
      metadata TEXT,
      observed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS idx_client_runtimes_supervisor_session_id ON client_runtimes (supervisor_session_id)`,
  sql`CREATE INDEX IF NOT EXISTS idx_client_runtimes_pid_client_id ON client_runtimes (pid, client_id)`,
  sql`CREATE INDEX IF NOT EXISTS idx_client_runtimes_adapter_session_id_client_id ON client_runtimes (adapter_session_id, client_id)`,
];

/**
 * SQLite DDL statements that create the client profiles storage table.
 */
export const CLIENT_PROFILES_DDL = [
  sql`
    CREATE TABLE IF NOT EXISTS client_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      config_dir TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (client_id, name)
    )
  `,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_client_profiles_default ON client_profiles (client_id) WHERE is_default = 1`,
];

/** DDL statements for every table needed by the clients-core package. */
export const CLIENTS_CORE_DDL = [...CLIENT_BINARY_DDL, ...CLIENT_RUNTIME_DDL, ...CLIENT_PROFILES_DDL];
