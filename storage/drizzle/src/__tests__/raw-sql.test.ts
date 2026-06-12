/**
 * Tests for the raw SQL executor seam ({@link getRawSqlExecutor}) and the
 * Postgres executor ({@link createPostgresRawSqlExecutor}).
 *
 * SQLite tests run against real in-memory databases — no mocks.
 * Postgres tests run against a hand-rolled fake {@link PostgresPoolLike} that
 * records every statement, exercising the real executor against the structural
 * seam without requiring the `pg` package to be installed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createDatabaseClient, type DatabaseClient } from '../client';
import {
  attachPgPoolErrorLogger,
  createPostgresRawSqlExecutor,
  getRawSqlExecutor,
  RAW_SQL_EXECUTOR,
  type PostgresPoolClientLike,
  type PostgresPoolLike,
  type PostgresQueryResultLike,
} from '../raw-sql';

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

// ---------------------------------------------------------------------------
// createPostgresRawSqlExecutor — fake pool, real executor
// ---------------------------------------------------------------------------

/**
 * A recorded query call captured by the fake pool / client.
 */
interface RecordedCall {
  /** SQL text (with $1-style placeholders). */
  text: string;
  /** Positional parameter values. */
  params: unknown[];
}

/**
 * Build a fake pool client that records every query call and returns a
 * configurable result. The `release` spy is exposed for assertion.
 * @param result - Query result to return for every call.
 * @returns Fake client with recorded calls and a release spy.
 */
function buildFakeClient(result: PostgresQueryResultLike): {
  client: PostgresPoolClientLike;
  calls: RecordedCall[];
  releaseSpy: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedCall[] = [];
  const releaseSpy = vi.fn();
  const client: PostgresPoolClientLike = {
    async query(text: string, params: unknown[]): Promise<PostgresQueryResultLike> {
      calls.push({ text, params });
      return result;
    },
    release: releaseSpy,
  };
  return { client, calls, releaseSpy };
}

/**
 * Build a fake pool that records every direct query call (standalone path) and
 * delegates pool.connect() to a configurable fake client factory.
 * @param connectFactory - Called each time pool.connect() is invoked; returns the client to check out.
 * @param poolResult - Query result for direct pool.query() calls.
 * @returns Fake pool with recorded direct calls.
 */
function buildFakePool(
  connectFactory: () => PostgresPoolClientLike,
  poolResult: PostgresQueryResultLike = { rows: [], rowCount: null },
): { pool: PostgresPoolLike; poolCalls: RecordedCall[]; errorListeners: Array<(error: Error) => void> } {
  const poolCalls: RecordedCall[] = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const pool: PostgresPoolLike = {
    async query(text: string, params: unknown[]): Promise<PostgresQueryResultLike> {
      poolCalls.push({ text, params });
      return poolResult;
    },
    async connect(): Promise<PostgresPoolClientLike> {
      return connectFactory();
    },
    async end(): Promise<void> {
      // no-op in tests
    },
    on(_event: 'error', listener: (error: Error) => void): void {
      errorListeners.push(listener);
    },
  };
  return { pool, poolCalls, errorListeners };
}

describe('createPostgresRawSqlExecutor', () => {
  it('sets dialect to "postgres"', () => {
    const { pool } = buildFakePool(() => buildFakeClient({ rows: [], rowCount: null }).client);
    const executor = createPostgresRawSqlExecutor(pool);

    expect(executor.dialect).toBe('postgres');
  });

  it('run() sends $1/$2 placeholders and returns rowsAffected from rowCount', async () => {
    const { pool, poolCalls } = buildFakePool(() => buildFakeClient({ rows: [], rowCount: 3 }).client, {
      rows: [],
      rowCount: 3,
    });
    const executor = createPostgresRawSqlExecutor(pool);

    const result = await executor.run(sql`UPDATE t SET a = ${1} WHERE b = ${2}`);

    expect(result.rowsAffected).toBe(3);
    expect(poolCalls).toHaveLength(1);
    expect(poolCalls[0]?.text).toMatch(/\$1/);
    expect(poolCalls[0]?.text).toMatch(/\$2/);
    expect(poolCalls[0]?.params).toEqual([1, 2]);
  });

  it('run() maps rowCount null to rowsAffected 0', async () => {
    const { pool } = buildFakePool(() => buildFakeClient({ rows: [], rowCount: null }).client, {
      rows: [],
      rowCount: null,
    });
    const executor = createPostgresRawSqlExecutor(pool);

    const result = await executor.run(sql`DELETE FROM t WHERE 1 = 0`);

    expect(result.rowsAffected).toBe(0);
  });

  it('all() returns the rows array from the pool result', async () => {
    const fakeRows = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ];
    const { pool } = buildFakePool(() => buildFakeClient({ rows: fakeRows, rowCount: 2 }).client, {
      rows: fakeRows,
      rowCount: 2,
    });
    const executor = createPostgresRawSqlExecutor(pool);

    const rows = await executor.all<{ id: string; value: number }>(sql`SELECT id, value FROM t`);

    expect(rows).toEqual(fakeRows);
  });

  it('standalone run goes through pool.query (not a session client)', async () => {
    const { client, calls: clientCalls, releaseSpy } = buildFakeClient({ rows: [], rowCount: 1 });
    const { pool, poolCalls } = buildFakePool(() => client, { rows: [], rowCount: 1 });
    const executor = createPostgresRawSqlExecutor(pool);

    await executor.run(sql`INSERT INTO t VALUES (${42})`);

    // Pool.query called once; pool.connect() (and thus the client) must NOT be called.
    expect(poolCalls).toHaveLength(1);
    expect(clientCalls).toHaveLength(0);
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('withSession routes run/all through the client, not pool.query', async () => {
    const { client, calls: clientCalls } = buildFakeClient({ rows: [], rowCount: 1 });
    const { pool, poolCalls } = buildFakePool(() => client);
    const executor = createPostgresRawSqlExecutor(pool);

    await executor.withSession(async (session) => {
      await session.run(sql`INSERT INTO t VALUES (${1})`);
      await session.all(sql`SELECT * FROM t`);
    });

    expect(clientCalls).toHaveLength(2);
    expect(poolCalls).toHaveLength(0);
  });

  it('withSession calls release() with no argument on success', async () => {
    const { client, releaseSpy } = buildFakeClient({ rows: [], rowCount: 0 });
    const { pool } = buildFakePool(() => client);
    const executor = createPostgresRawSqlExecutor(pool);

    await executor.withSession(async () => 'ok');

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith();
  });

  it('withSession calls release(true) and rethrows when the callback rejects', async () => {
    const { client, releaseSpy } = buildFakeClient({ rows: [], rowCount: 0 });
    const { pool } = buildFakePool(() => client);
    const executor = createPostgresRawSqlExecutor(pool);
    const boom = new Error('callback failure');

    await expect(
      executor.withSession(async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(true);
  });

  it('sql.raw("COMMIT") serializes to text "COMMIT" with empty params', async () => {
    const { pool, poolCalls } = buildFakePool(() => buildFakeClient({ rows: [], rowCount: 0 }).client, {
      rows: [],
      rowCount: 0,
    });
    const executor = createPostgresRawSqlExecutor(pool);

    // Pins migration-runner compatibility: applyMigrations uses sql.raw('COMMIT')
    // which must serialize to plain text with no parameters.
    await executor.run(sql.raw('COMMIT'));

    expect(poolCalls).toHaveLength(1);
    expect(poolCalls[0]?.text).toBe('COMMIT');
    expect(poolCalls[0]?.params).toEqual([]);
  });
});

describe('attachPgPoolErrorLogger', () => {
  it('registers an error listener on the pool', () => {
    const { pool, errorListeners } = buildFakePool(() => buildFakeClient({ rows: [], rowCount: null }).client);

    attachPgPoolErrorLogger(pool);

    expect(errorListeners).toHaveLength(1);
  });

  it('logs an idle-connection error instead of throwing', () => {
    const { pool, errorListeners } = buildFakePool(() => buildFakeClient({ rows: [], rowCount: null }).client);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      attachPgPoolErrorLogger(pool);
      const idleConnectionError = new Error('terminating connection due to administrator command');

      // node-postgres emits this for idle pooled connections when the backend
      // goes away; the listener must absorb it (log) — never rethrow, which
      // would escalate to an uncaught exception and kill the process.
      expect(() => errorListeners[0]?.(idleConnectionError)).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Postgres pool'), idleConnectionError);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
