import { sql, type SQL } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';

/**
 * SQL statements that install the canonical session-storage schema used by
 * tests that register the real session and agent storage handlers.
 */
export const SESSION_STORAGE_TEST_SCHEMA_SQL: SQL[] = [
  sql`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'archived', 'discovered')),
      lead_agent_id TEXT,
      parent_session_id TEXT,
      root_session_id TEXT,
      fork_point_message_id TEXT,
      branch_kind TEXT CHECK (
        branch_kind IS NULL
        OR branch_kind IN ('fork', 'branch', 'subagent', 'compress', 'rewrite', 'coordinator', 'aside')
      ),
      adapter_name TEXT,
      adapter_session_id TEXT,
      adapter_id TEXT,
      client_id TEXT,
      client_account_id TEXT,
      last_client_identity_observation TEXT,
      is_orchestrated INTEGER DEFAULT 0,
      title TEXT,
      summary TEXT,
      summary_updated_at INTEGER,
      is_imported INTEGER DEFAULT 0,
      fork_transforms TEXT,
      target_working_directory TEXT,
      execution_target_id TEXT,
      approval_policy_override TEXT,
      spawning_tool_call_id TEXT
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS sessions_adapter_session_id_idx ON sessions(adapter_session_id)`,
  sql`CREATE INDEX IF NOT EXISTS sessions_execution_target_id_idx ON sessions(execution_target_id)`,
  sql`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      adapter_session_id TEXT,
      model TEXT,
      cwd TEXT,
      provider_config_id TEXT,
      persona_id TEXT,
      profile_id TEXT,
      harness_id TEXT,
      client_id TEXT,
      compression_mode TEXT,
      role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
      status TEXT NOT NULL CHECK (status IN ('idle', 'active', 'dead', 'disposed')),
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS agents_session_id_idx ON agents(session_id)`,
  sql`CREATE INDEX IF NOT EXISTS agents_adapter_name_idx ON agents(adapter_name)`,
  sql`CREATE INDEX IF NOT EXISTS agents_status_idx ON agents(status)`,
  sql`CREATE INDEX IF NOT EXISTS agents_client_id_idx ON agents(client_id)`,
];

/**
 * Install the canonical session-storage test schema onto a test database.
 * @param db - Database to initialize
 */
export async function installSessionStorageTestSchema(db: MakaioDatabase): Promise<void> {
  for (const statement of SESSION_STORAGE_TEST_SCHEMA_SQL) {
    await db.run(statement);
  }
}
