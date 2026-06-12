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
import { createTempDb, createDbCleanup, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { installMessagesFtsTestSchema, installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { registerDrizzleMessageStorage } from '../drizzle-handler.js';
import { MessageStorageSubjects } from '../namespace.js';

// ---------------------------------------------------------------------------
// Test DB factory
// ---------------------------------------------------------------------------

interface FtsTestContext {
  db: MakaioDatabase;
  /** Executes a raw SQL write through the harness executor seam. */
  exec: TestDbContext['exec'];
  cleanup: () => void;
}

/**
 * Creates a temporary SQLite database with the messages table, FTS5 virtual
 * table, sync triggers, and a registered ftsSearch handler.
 * @returns Test context with db, exec, and cleanup
 */
async function createFtsTestDb(): Promise<FtsTestContext> {
  const { db, exec, close, dbPath } = await createTempDb('msg-fts');

  // Session tier first (turns/messages reference sessions), then the messages
  // tier with the FTS5 table and sync triggers.
  await installSessionStorageTestSchema(db);
  await installMessagesFtsTestSchema(db);

  // Seed a session so FK constraints are satisfied
  await exec(sql`
    INSERT INTO sessions (session_id, created_at, last_activity_at, status)
    VALUES ('session-1', 1000, 1000, 'active')
  `);

  const handlerCleanup = registerDrizzleMessageStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));

  const cleanup = createDbCleanup(handlerCleanup, close, dbPath);
  return { db, exec, cleanup };
}

/**
 * Inserts a message directly into the messages table.
 * The INSERT trigger automatically syncs the row into messages_fts.
 * @param exec - Raw SQL write seam from the test context
 * @param messageId - Unique message identifier
 * @param contentText - Plain-text content to index
 * @param timestamp - Ordering timestamp (Unix ms)
 */
async function insertMessage(
  exec: FtsTestContext['exec'],
  messageId: string,
  contentText: string,
  timestamp: number = Date.now(),
): Promise<void> {
  await exec(sql`
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
    await insertMessage(ctx.exec, 'msg-1', 'TypeScript generics conditional types mapped types', 1000);
    await insertMessage(ctx.exec, 'msg-2', 'TypeScript compiler strict mode tsconfig settings', 2000);

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
      ctx.exec,
      'msg-dense',
      'authentication authentication authentication JWT authentication token authentication',
      1000,
    );
    // msg-sparse mentions it once
    await insertMessage(ctx.exec, 'msg-sparse', 'I heard about authentication once', 2000);

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
