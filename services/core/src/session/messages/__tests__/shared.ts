/**
 * Shared test utilities for messages schema tests.
 */
import { sql } from 'drizzle-orm';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';

/**
 * SQL statement to create the sessions table for testing.
 * Minimal schema to satisfy FK constraints.
 */
const CREATE_SESSIONS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY
  )
`;

/**
 * SQL statement to create the turns table for testing.
 * Minimal schema to satisfy FK constraints.
 */
const CREATE_TURNS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
  )
`;

/**
 * SQL statement to create the messages table for testing.
 * Mirrors the schema from schema.ts with nullable turn_id.
 */
const CREATE_MESSAGES_TABLE_SQL = sql`
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
`;

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Creates a temp file SQLite database for testing messages schema.
 *
 * Uses a temp file in os.tmpdir() instead of :memory: to ensure
 * proper SQLite behavior including foreign key constraints and
 * cascade deletes.
 * @returns Test database context with cleanup that removes temp file
 */
export async function createTestMessageDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath, exec } = await createTempDb('msg');

  // Create tables
  await exec(CREATE_SESSIONS_TABLE_SQL);
  await exec(CREATE_TURNS_TABLE_SQL);
  await exec(CREATE_MESSAGES_TABLE_SQL);

  // Insert a test session for FK
  await exec(sql`INSERT INTO sessions (session_id) VALUES ('session-1')`);

  // No handler cleanup needed for this test context
  const cleanup = createDbCleanup(() => {}, close, dbPath);

  return { db, close, dbPath, exec, cleanup };
}
