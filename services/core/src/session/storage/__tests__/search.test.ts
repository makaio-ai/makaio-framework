/**
 * Tests for FTS5 search handler.
 *
 * Uses content-backed FTS5 that auto-syncs with messages table via triggers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { createTestDb, type TestDbContext } from './shared.js';

describe('search', () => {
  let ctx: TestDbContext;
  let db: MakaioDatabase;

  beforeEach(async () => {
    ctx = await createTestDb();
    db = ctx.db;

    // Create turns table (messages depends on it)
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'error')),
        error TEXT
      )
    `);

    // Create messages table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content_text TEXT NOT NULL,
        blocks TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT,
        adapter_session_id TEXT,
        timestamp INTEGER NOT NULL,
        edit_of TEXT,
        origin TEXT
      )
    `);

    // Create content-backed FTS5 table
    await db.run(sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id,
        content_text,
        content='messages',
        content_rowid='rowid',
        tokenize='porter unicode61'
      )
    `);

    // Create triggers for FTS sync
    await db.run(sql`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, session_id, content_text)
        VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
      END
    `);

    await db.run(sql`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
        VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
      END
    `);

    await db.run(sql`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
        VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
        INSERT INTO messages_fts(rowid, session_id, content_text)
        VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
      END
    `);

    // Create session and turn
    await db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-1', 1000, 2000, 'active', 'Authentication Flow')
    `);

    await db.run(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-1', 'session-1', 1000, 'completed')
    `);

    // Insert messages (FTS auto-syncs via triggers)
    await db.run(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES
        ('msg-1', 'turn-1', 'session-1', 'user', 'How do I implement JWT authentication?', 1001),
        ('msg-2', 'turn-1', 'session-1', 'assistant', 'Here is how you implement JWT tokens...', 1002)
    `);
  });

  afterEach(() => ctx.cleanup());

  it('should find sessions by content', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'JWT authentication',
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('session-1');
  });

  it('should return empty for no matches', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'nonexistent topic',
    });

    expect(result.sessions).toHaveLength(0);
  });

  it('should support partial word matching with wildcard', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'authent*',
    });

    expect(result.sessions).toHaveLength(1);
  });

  it('should return empty for empty query', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: '',
    });

    expect(result.sessions).toHaveLength(0);
  });

  it('should return empty for whitespace-only query', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: '   ',
    });

    expect(result.sessions).toHaveLength(0);
  });

  it('should respect limit parameter', async () => {
    // Create another session with turn and message
    await db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-2', 2000, 3000, 'active', 'Token Management')
    `);
    await db.run(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-2', 'session-2', 2000, 'completed')
    `);
    await db.run(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES ('msg-3', 'turn-2', 'session-2', 'user', 'How do JWT tokens expire?', 2001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'JWT',
      limit: 1,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it('should filter search results by status', async () => {
    await db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-2', 2000, 3000, 'archived', 'Archived JWT Notes')
    `);
    await db.run(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-2', 'session-2', 2000, 'completed')
    `);
    await db.run(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES ('msg-3', 'turn-2', 'session-2', 'user', 'JWT cleanup checklist', 2001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'JWT',
      status: 'active',
    });

    expect(result.total).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('session-1');
  });

  it('should pick first inserted user message preview when timestamps collide', async () => {
    await db.run(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-collision', 4000, 5000, 'active', 'Collision Session')
    `);
    await db.run(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-collision', 'session-collision', 4000, 'completed')
    `);
    await db.run(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES
        ('msg-collision-a', 'turn-collision', 'session-collision', 'user', 'Collision first', 5001),
        ('msg-collision-b', 'turn-collision', 'session-collision', 'user', 'Collision second', 5001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'Collision',
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('session-collision');
    expect(result.sessions[0].preview?.firstUserMessage).toBe('Collision first');
  });
});
