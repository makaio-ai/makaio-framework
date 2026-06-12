/**
 * Tests for the Postgres FTS strategy.
 *
 * Full search behavior runs in the storage conformance suite against a live
 * Postgres server; this file pins the strategy's boot-time contract
 * (chain-owned provisioning issues no statements) and its loud failure when
 * handed a table that is not the messages table.
 */
import { describe, it, expect } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { brandDatabase, type MakaioDatabase, type RawSqlExecutor, type RawSqlSession } from '@makaio/storage-drizzle';
import { postgresStorageEngine } from '../engine.js';
import { postgresFtsSearchStrategy } from '../fts-strategy.js';
import { storageEngine } from '../index.js';

/**
 * Build a postgres-branded handle over a recording executor: every raw
 * statement is captured instead of hitting a server.
 * @returns The branded handle plus the recorded statement texts.
 */
function createRecordingDb(): { db: MakaioDatabase; statements: string[] } {
  const statements: string[] = [];
  const pgDialect = new PgDialect();

  const session: RawSqlSession = {
    run(query) {
      statements.push(pgDialect.sqlToQuery(query).sql);
      return Promise.resolve({ rowsAffected: 0 });
    },
    all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
      statements.push(pgDialect.sqlToQuery(query).sql);
      return Promise.resolve([]);
    },
  };
  const executor: RawSqlExecutor = {
    dialect: 'postgres',
    run: session.run,
    all: session.all,
    withSession: (fn) => fn(session),
  };

  const db = brandDatabase({}, 'postgres', executor) as MakaioDatabase;
  return { db, statements };
}

/** A table that is plainly not the messages table. */
const notMessagesTable = sqliteTable('not_messages', {
  id: text('id').primaryKey(),
});

describe('engine wiring', () => {
  it('backs the postgres engine (and its auto-resolve alias)', () => {
    expect(postgresStorageEngine.fts).toBe(postgresFtsSearchStrategy);
    expect(storageEngine.fts).toBe(postgresFtsSearchStrategy);
    expect(postgresFtsSearchStrategy.dialect).toBe('postgres');
  });
});

describe('provisionSearchIndex', () => {
  it('issues no statements — the search index ships through the migration chain', async () => {
    const { db, statements } = createRecordingDb();

    await expect(postgresFtsSearchStrategy.provisionSearchIndex(db)).resolves.toBeUndefined();

    expect(statements).toEqual([]);
  });
});

describe('required messages columns', () => {
  it('searchMessages rejects loudly when the table is missing the messageId column', async () => {
    const { db } = createRecordingDb();

    await expect(
      postgresFtsSearchStrategy.searchMessages(db, notMessagesTable, { query: 'x', limit: 10 }),
    ).rejects.toThrow(/missing the 'messageId' column/);
  });

  it('searchMessageExcerpts rejects loudly when the table is missing the messageId column', async () => {
    const { db } = createRecordingDb();

    await expect(
      postgresFtsSearchStrategy.searchMessageExcerpts(db, notMessagesTable, { query: 'x', limit: 10 }),
    ).rejects.toThrow(/missing the 'messageId' column/);
  });
});

describe('fetchFirstUserMessagePreviews', () => {
  it('returns an empty map for an empty id list without touching the database', async () => {
    const { db, statements } = createRecordingDb();

    const previews = await postgresFtsSearchStrategy.fetchFirstUserMessagePreviews(db, []);

    expect(previews.size).toBe(0);
    expect(statements).toEqual([]);
  });
});
