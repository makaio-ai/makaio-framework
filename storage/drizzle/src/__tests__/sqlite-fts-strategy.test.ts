/**
 * Tests for the built-in SQLite FTS strategy.
 *
 * Runs against a real in-memory database with the central migration chain
 * applied — no mocks. Cross-dialect behavior parity is the conformance
 * suite's job; this file pins provisioning and the strategy's own search
 * contracts on minimal seeded data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';
import { createDatabaseClient, type DatabaseClient } from '../client';
import { sqliteStorageEngine } from '../engine/sqlite/engine';
import { sqliteFtsSearchStrategy } from '../engine/sqlite/fts-strategy';
import { getRawSqlExecutor } from '../raw-sql';

/**
 * Stand-in messages table object. The SQLite strategy accepts and ignores the
 * table parameter (its queries join `messages_fts` to `messages` by rowid),
 * so a minimal table satisfies the contract here.
 */
const messagesTableStandIn = sqliteTable('messages', {
  messageId: text('message_id').primaryKey(),
});

let client: DatabaseClient;

beforeAll(async () => {
  client = await createDatabaseClient({ url: ':memory:' });

  // Central chain first (creates sessions/messages), then engine-owned
  // search-index provisioning — the boot ordering of runtime hosts.
  const migrations = readMigrations({ expectedDialect: 'sqlite' });
  await applyMigrations(client.db, migrations);
  await sqliteFtsSearchStrategy.provisionSearchIndex(client.db);

  // Seed one session with two user messages; msg-alpha is inserted first so
  // it owns the lower rowid (preview tie-break) at an identical timestamp.
  const rawSql = getRawSqlExecutor(client.db);
  await rawSql.run(sql`
    INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
    VALUES ('session-1', 1000, 1000, 'active', 'Strategy test session')
  `);
  await rawSql.run(sql`
    INSERT INTO messages (message_id, session_id, role, content_text, blocks, timestamp)
    VALUES ('msg-alpha', 'session-1', 'user', 'alpha xyzftstoken content', '[]', 2000)
  `);
  await rawSql.run(sql`
    INSERT INTO messages (message_id, session_id, role, content_text, blocks, timestamp)
    VALUES ('msg-omega', 'session-1', 'user', 'omega xyzftstoken content', '[]', 2000)
  `);
});

afterAll(async () => {
  await client.close();
});

describe('engine wiring', () => {
  it('backs the built-in sqlite engine', () => {
    expect(sqliteStorageEngine.fts).toBe(sqliteFtsSearchStrategy);
    expect(sqliteFtsSearchStrategy.dialect).toBe('sqlite');
  });
});

describe('provisionSearchIndex', () => {
  it('creates the messages_fts virtual table and its sync triggers', async () => {
    const rawSql = getRawSqlExecutor(client.db);

    const tables = await rawSql.all<{ name: string }>(sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'
    `);
    expect(tables).toHaveLength(1);

    const triggers = await rawSql.all<{ name: string }>(sql`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('messages_ai', 'messages_ad', 'messages_au')
      ORDER BY name
    `);
    expect(triggers.map((t) => t.name)).toEqual(['messages_ad', 'messages_ai', 'messages_au']);
  });

  it('is idempotent across boots (IF NOT EXISTS plus index rebuild)', async () => {
    await expect(sqliteFtsSearchStrategy.provisionSearchIndex(client.db)).resolves.toBeUndefined();
  });
});

describe('searchMessages', () => {
  it('returns camelCase-aliased rows and the total match count', async () => {
    const { rows, total } = await sqliteFtsSearchStrategy.searchMessages<{
      messageId: string;
      sessionId: string;
      contentText: string;
    }>(client.db, messagesTableStandIn, { query: 'alpha', sessionId: 'session-1', limit: 10 });

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBe('msg-alpha');
    expect(rows[0]?.sessionId).toBe('session-1');
    expect(rows[0]?.contentText).toBe('alpha xyzftstoken content');
  });

  it('sanitizes FTS5 operator characters instead of choking on them', async () => {
    // Unsanitized, a stray quote is invalid FTS5 MATCH syntax.
    const { rows, total } = await sqliteFtsSearchStrategy.searchMessages(client.db, messagesTableStandIn, {
      query: 'alpha "broken',
      limit: 10,
    });
    expect(total).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe('searchMessageExcerpts', () => {
  it('returns positive bm25 scores and <mark> excerpts', async () => {
    const { results, total } = await sqliteFtsSearchStrategy.searchMessageExcerpts(client.db, messagesTableStandIn, {
      query: 'xyzftstoken',
      sessionId: 'session-1',
      limit: 10,
    });

    expect(total).toBe(2);
    expect(results).toHaveLength(2);
    for (const hit of results) {
      expect(hit.sessionId).toBe('session-1');
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.excerpt).toMatch(/<mark>[^<]+<\/mark>/);
    }
  });
});

describe('searchSessionRows / countSessionMatches', () => {
  it('matches sessions by message content', async () => {
    const rows = await sqliteFtsSearchStrategy.searchSessionRows<{ session_id: string; title: string | null }>(
      client.db,
      { query: 'xyzftstoken', likePattern: '%xyzftstoken%', limit: 20 },
    );
    expect(rows.map((r) => r.session_id)).toEqual(['session-1']);

    const total = await sqliteFtsSearchStrategy.countSessionMatches(client.db, {
      query: 'xyzftstoken',
      likePattern: '%xyzftstoken%',
    });
    expect(total).toBe(1);
  });

  it('matches sessions by title LIKE pattern and applies the status filter', async () => {
    const input = { query: 'zzznomessagematch', likePattern: '%strategy test%' };

    const rows = await sqliteFtsSearchStrategy.searchSessionRows<{ session_id: string }>(client.db, {
      ...input,
      limit: 20,
    });
    expect(rows.map((r) => r.session_id)).toEqual(['session-1']);

    expect(await sqliteFtsSearchStrategy.countSessionMatches(client.db, { ...input, status: 'active' })).toBe(1);
    expect(await sqliteFtsSearchStrategy.countSessionMatches(client.db, { ...input, status: 'archived' })).toBe(0);
  });
});

describe('fetchFirstUserMessagePreviews', () => {
  it('resolves the first user message, tie-breaking equal timestamps by rowid', async () => {
    const previews = await sqliteFtsSearchStrategy.fetchFirstUserMessagePreviews(client.db, ['session-1']);
    expect(previews.get('session-1')).toBe('alpha xyzftstoken content');
  });

  it('returns an empty map for an empty id list without touching the database', async () => {
    const previews = await sqliteFtsSearchStrategy.fetchFirstUserMessagePreviews(client.db, []);
    expect(previews.size).toBe(0);
  });
});
