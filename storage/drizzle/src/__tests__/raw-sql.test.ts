/**
 * Tests for the raw SQL executor seam ({@link getRawSqlExecutor}).
 *
 * All tests run against real in-memory SQLite databases — no mocks. The
 * Postgres executor moved to `@makaio/storage-pg` and is tested there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createDatabaseClient, type DatabaseClient } from '../client';
import { getRawSqlExecutor, RAW_SQL_EXECUTOR } from '../raw-sql';

describe('getRawSqlExecutor', () => {
  let openClients: DatabaseClient[] = [];

  afterEach(async () => {
    for (const client of openClients) {
      await client.close();
    }
    openClients = [];
  });

  /**
   * Creates and tracks an in-memory factory client.
   * @returns The tracked client.
   */
  async function createTrackedClient(): Promise<DatabaseClient> {
    const client = await createDatabaseClient({ url: ':memory:' });
    openClients.push(client);
    return client;
  }

  describe('factory-created (branded) handles', () => {
    it('returns the executor attached by createDatabaseClient, stable across calls', async () => {
      const { db } = await createTrackedClient();

      const first = getRawSqlExecutor(db);
      const second = getRawSqlExecutor(db);

      expect(first.dialect).toBe('sqlite');
      expect(second).toBe(first);
    });

    it('attaches the executor non-enumerably so it does not travel with spreads', async () => {
      const { db } = await createTrackedClient();

      expect(Object.getOwnPropertySymbols({ ...db })).not.toContain(RAW_SQL_EXECUTOR);
    });

    it('round-trips run/all: DDL, parameterized DML with rowsAffected, and typed reads', async () => {
      const { db } = await createTrackedClient();
      const rawSql = getRawSqlExecutor(db);

      await rawSql.run(sql`CREATE TABLE raw_sql_test (id TEXT PRIMARY KEY, value INTEGER NOT NULL)`);

      const insert = await rawSql.run(sql`INSERT INTO raw_sql_test (id, value) VALUES ('a', 1), ('b', 2)`);
      expect(insert.rowsAffected).toBe(2);

      const update = await rawSql.run(sql`UPDATE raw_sql_test SET value = value + 10 WHERE id = ${'a'}`);
      expect(update.rowsAffected).toBe(1);

      const rows = await rawSql.all<{ id: string; value: number }>(sql`SELECT id, value FROM raw_sql_test ORDER BY id`);
      expect(rows).toEqual([
        { id: 'a', value: 11 },
        { id: 'b', value: 2 },
      ]);
    });
  });

  describe('withSession', () => {
    it('executes a full raw BEGIN/COMMIT cycle and commits the work', async () => {
      const { db } = await createTrackedClient();
      const rawSql = getRawSqlExecutor(db);
      await rawSql.run(sql`CREATE TABLE session_commit_test (id TEXT PRIMARY KEY)`);

      const result = await rawSql.withSession(async (session) => {
        await session.run(sql.raw('BEGIN'));
        await session.run(sql`INSERT INTO session_commit_test (id) VALUES ('committed')`);
        await session.run(sql.raw('COMMIT'));
        return 'done';
      });

      expect(result).toBe('done');
      const rows = await rawSql.all<{ id: string }>(sql`SELECT id FROM session_commit_test`);
      expect(rows).toEqual([{ id: 'committed' }]);
    });

    it('isolates work inside an open transaction: ROLLBACK discards every statement of the session', async () => {
      const { db } = await createTrackedClient();
      const rawSql = getRawSqlExecutor(db);
      await rawSql.run(sql`CREATE TABLE session_rollback_test (id TEXT PRIMARY KEY)`);

      await rawSql.withSession(async (session) => {
        await session.run(sql.raw('BEGIN'));
        await session.run(sql`INSERT INTO session_rollback_test (id) VALUES ('discarded')`);

        // The statement is visible inside the same pinned session...
        const inside = await session.all<{ id: string }>(sql`SELECT id FROM session_rollback_test`);
        expect(inside).toEqual([{ id: 'discarded' }]);

        await session.run(sql.raw('ROLLBACK'));
      });

      // ...and gone after the rollback, proving BEGIN/ROLLBACK acted on the
      // same connection that ran the INSERT.
      const after = await rawSql.all<{ id: string }>(sql`SELECT id FROM session_rollback_test`);
      expect(after).toEqual([]);
    });
  });

  describe('unbranded handles (hand-rolled test clients)', () => {
    it('synthesizes a SQLite executor over the native run/all API', async () => {
      const rawDb = drizzle({ connection: { url: ':memory:' } });
      try {
        const rawSql = getRawSqlExecutor(rawDb);

        expect(rawSql.dialect).toBe('sqlite');
        await rawSql.run(sql`CREATE TABLE fallback_test (id TEXT PRIMARY KEY)`);
        const insert = await rawSql.run(sql`INSERT INTO fallback_test (id) VALUES ('x')`);
        expect(insert.rowsAffected).toBe(1);
        const rows = await rawSql.all<{ id: string }>(sql`SELECT id FROM fallback_test`);
        expect(rows).toEqual([{ id: 'x' }]);
      } finally {
        rawDb.$client.close();
      }
    });

    it('throws an actionable error naming createDatabaseClient for handles without a raw API', async () => {
      const { db } = await createTrackedClient();

      // A shallow copy keeps the structural type but loses both the
      // non-enumerable executor attachment and the prototype methods.
      const detachedHandle = { ...db };

      expect(() => getRawSqlExecutor(detachedHandle)).toThrow(/createDatabaseClient/);
    });
  });
});
