import { sql, type SQL } from 'drizzle-orm';
import { getRawSqlExecutor, type MakaioDatabase } from '@makaio/storage-drizzle';

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
      context_inheritance TEXT CHECK (
        context_inheritance IS NULL
        OR context_inheritance IN ('parent-history', 'none')
      ),
      root_session_id TEXT,
      fork_point_message_id TEXT,
      branch_kind TEXT CHECK (
        branch_kind IS NULL
        OR branch_kind IN ('fork', 'branch', 'subagent', 'compress', 'rewrite', 'coordinator', 'aside')
      ),
      adapter_name TEXT,
      adapter_session_id TEXT,
      current_adapter_session_id TEXT,
      current_adapter_session_id_state TEXT NOT NULL DEFAULT 'inherited' CHECK (
        current_adapter_session_id_state IN ('inherited', 'moved', 'confirmed')
        AND (current_adapter_session_id_state <> 'confirmed' OR current_adapter_session_id IS NOT NULL)
        AND (current_adapter_session_id_state = 'confirmed' OR current_adapter_session_id IS NULL)
      ),
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
      metadata TEXT,
      spawning_tool_call_id TEXT,
      -- Import provenance fields
      source TEXT,
      parent_external_session_id TEXT,
      log_file_path TEXT,
      discovered_at INTEGER,
      import_status TEXT CHECK (
        import_status IS NULL
        OR import_status IN ('discovered', 'imported', 'tracking')
      ),
      is_sidechain INTEGER,
      machine_id TEXT
    )
  `,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessions_source_adapter_session_id ON sessions(source, adapter_session_id)`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessions_log_file_path ON sessions(log_file_path)`,
  sql`CREATE INDEX IF NOT EXISTS sessions_adapter_session_id_idx ON sessions(adapter_session_id)`,
  sql`CREATE INDEX IF NOT EXISTS idx_sessions_import_status ON sessions(import_status)`,
  sql`CREATE INDEX IF NOT EXISTS sessions_execution_target_id_idx ON sessions(execution_target_id)`,
  sql`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      adapter_session_id TEXT,
      current_adapter_session_id TEXT,
      current_adapter_session_id_state TEXT NOT NULL DEFAULT 'inherited' CHECK (
        current_adapter_session_id_state IN ('inherited', 'moved', 'confirmed')
        AND (current_adapter_session_id_state <> 'confirmed' OR current_adapter_session_id IS NOT NULL)
        AND (current_adapter_session_id_state = 'confirmed' OR current_adapter_session_id IS NULL)
      ),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      currency_fence INTEGER NOT NULL DEFAULT 0 CHECK (currency_fence >= 0),
      model TEXT,
      cwd TEXT,
      allowed_directories TEXT,
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
  sql`
    CREATE TABLE IF NOT EXISTS adapter_session_claims (
      claim_id TEXT PRIMARY KEY NOT NULL,
      machine_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
      claim_token TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK (fence >= 1),
      status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'releasing', 'abandoned')),
      claimed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `,
  sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_adapter_session_claims_owner
    ON adapter_session_claims(machine_id, adapter_id, provider_session_id)
  `,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_adapter_session_claims_token ON adapter_session_claims(claim_token)`,
  sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_adapter_session_claims_agent_fence ON adapter_session_claims(agent_id, fence)`,
  sql`CREATE INDEX IF NOT EXISTS adapter_session_claims_agent_id_idx ON adapter_session_claims(agent_id)`,
  sql`CREATE INDEX IF NOT EXISTS adapter_session_claims_session_id_idx ON adapter_session_claims(session_id)`,
];

/**
 * Install the canonical session-storage test schema onto a test database.
 * @param db - Database to initialize
 */
export async function installSessionStorageTestSchema(db: MakaioDatabase): Promise<void> {
  const rawSql = getRawSqlExecutor(db);
  for (const statement of SESSION_STORAGE_TEST_SCHEMA_SQL) {
    await rawSql.run(statement);
  }
}

/**
 * SQL statements that install the messages tier of the session-storage test
 * schema: `turns`, `messages` (canonical column set including
 * `adapter_message_id` and a nullable `turn_id`), the content-backed
 * `messages_fts` FTS5 virtual table, and the FTS sync triggers. Mirrors the
 * FTS5 setup the runtime's migration step applies on SQLite.
 */
export const MESSAGES_FTS_TEST_SCHEMA_SQL: SQL[] = [
  sql`
    CREATE TABLE IF NOT EXISTS turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'error')),
      error TEXT,
      initiator TEXT,
      turn_anchor_id TEXT
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      turn_id TEXT REFERENCES turns(turn_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content_text TEXT NOT NULL,
      blocks TEXT NOT NULL DEFAULT '[]',
      agent_id TEXT,
      adapter_session_id TEXT,
      adapter_message_id TEXT,
      timestamp INTEGER NOT NULL,
      edit_of TEXT,
      origin TEXT
    )
  `,
  sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_adapter_message_id_session
    ON messages(adapter_message_id, session_id)
  `,
  sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      session_id,
      content_text,
      content='messages',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `,
  sql`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, session_id, content_text)
      VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
    END
  `,
  sql`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
      VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
    END
  `,
  sql`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
      VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
      INSERT INTO messages_fts(rowid, session_id, content_text)
      VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
    END
  `,
];

/**
 * Install the messages tier of the session-storage test schema on top of
 * {@link installSessionStorageTestSchema} (the `turns` and `messages` tables
 * reference `sessions`). FTS-backed search tests call this before inserting
 * message fixtures; the triggers keep `messages_fts` in sync automatically.
 * @param db - Database to initialize
 */
export async function installMessagesFtsTestSchema(db: MakaioDatabase): Promise<void> {
  const rawSql = getRawSqlExecutor(db);
  for (const statement of MESSAGES_FTS_TEST_SCHEMA_SQL) {
    await rawSql.run(statement);
  }
}
