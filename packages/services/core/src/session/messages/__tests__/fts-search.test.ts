/**
 * Tests for the message ftsSearch handler and BM25 score projection.
 *
 * Verifies that:
 * 1. Returned scores are positive (the handler negates bm25() and orders DESC).
 * 2. Higher-relevance messages rank above lower-relevance ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { registerDrizzleMessageStorage } from '../drizzle-handler.js';
import { MessageStorageSubjects } from '../namespace.js';

// ---------------------------------------------------------------------------
// Minimal schema SQL for the FTS search test database
// ---------------------------------------------------------------------------

const CREATE_SESSIONS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY
  )
`;

const CREATE_TURNS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
  )
`;

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

const CREATE_MESSAGES_FTS_SQL = sql`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    session_id,
    content_text,
    content='messages',
    content_rowid='rowid',
    tokenize='porter unicode61'
  )
`;

const CREATE_TRIGGER_AI_SQL = sql`
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, session_id, content_text)
    VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
  END
`;

const CREATE_TRIGGER_AD_SQL = sql`
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
    VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
  END
`;

const CREATE_TRIGGER_AU_SQL = sql`
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
    VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
    INSERT INTO messages_fts(rowid, session_id, content_text)
    VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
  END
`;

// ---------------------------------------------------------------------------
// Test DB factory
// ---------------------------------------------------------------------------

interface FtsTestContext {
  db: MakaioDatabase;
  cleanup: () => void;
}

/**
 * Creates a temporary SQLite database with the messages table, FTS5 virtual
 * table, sync triggers, and a registered ftsSearch handler.
 * @returns Test context with db and cleanup
 */
async function createFtsTestDb(): Promise<FtsTestContext> {
  const { db, close, dbPath } = await createTempDb('msg-fts');

  await db.run(CREATE_SESSIONS_TABLE_SQL);
  await db.run(CREATE_TURNS_TABLE_SQL);
  await db.run(CREATE_MESSAGES_TABLE_SQL);
  await db.run(CREATE_MESSAGES_FTS_SQL);
  await db.run(CREATE_TRIGGER_AI_SQL);
  await db.run(CREATE_TRIGGER_AD_SQL);
  await db.run(CREATE_TRIGGER_AU_SQL);

  // Seed a session so FK constraints are satisfied
  await db.run(sql`INSERT INTO sessions (session_id) VALUES ('session-1')`);

  const handlerCleanup = registerDrizzleMessageStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));

  const cleanup = createDbCleanup(handlerCleanup, close, dbPath);
  return { db, cleanup };
}

/**
 * Inserts a message directly into the messages table.
 * The INSERT trigger automatically syncs the row into messages_fts.
 * @param db - Drizzle database instance
 * @param messageId - Unique message identifier
 * @param contentText - Plain-text content to index
 * @param timestamp - Ordering timestamp (Unix ms)
 */
async function insertMessage(
  db: MakaioDatabase,
  messageId: string,
  contentText: string,
  timestamp: number = Date.now(),
): Promise<void> {
  await db.run(sql`
    INSERT INTO messages (message_id, session_id, role, content_text, blocks, timestamp)
    VALUES (${messageId}, 'session-1', 'user', ${contentText}, '[]', ${timestamp})
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('message ftsSearch handler – BM25 score projection', () => {
  let ctx: FtsTestContext;

  beforeEach(async () => {
    ctx = await createFtsTestDb();
  });

  afterEach(() => ctx.cleanup());

  it('returns positive scores for matching messages', async () => {
    await insertMessage(ctx.db, 'msg-1', 'TypeScript generics conditional types mapped types', 1000);
    await insertMessage(ctx.db, 'msg-2', 'TypeScript compiler strict mode tsconfig settings', 2000);

    const result = await MakaioBus.request(MessageStorageSubjects.ftsSearch, {
      query: 'TypeScript',
      sessionId: 'session-1',
    });

    expect(result.results.length).toBeGreaterThan(0);
    for (const hit of result.results) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it('ranks the more-relevant message first when ordering by score', async () => {
    // msg-dense repeats the search term multiple times → higher BM25 score
    await insertMessage(
      ctx.db,
      'msg-dense',
      'authentication authentication authentication JWT authentication token authentication',
      1000,
    );
    // msg-sparse mentions it once
    await insertMessage(ctx.db, 'msg-sparse', 'I heard about authentication once', 2000);

    const result = await MakaioBus.request(MessageStorageSubjects.ftsSearch, {
      query: 'authentication',
      sessionId: 'session-1',
    });

    expect(result.results).toHaveLength(2);
    // Higher score must come first (handler orders by score DESC)
    expect(result.results[0].score).toBeGreaterThanOrEqual(result.results[1].score);
    expect(result.results[0].messageId).toBe('msg-dense');
  });
});
