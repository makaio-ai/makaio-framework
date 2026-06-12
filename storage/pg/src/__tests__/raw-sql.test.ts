/**
 * Tests for the Postgres raw SQL executor ({@link createPostgresRawSqlExecutor})
 * and the pool error logger ({@link attachPgPoolErrorLogger}).
 *
 * They run against a hand-rolled fake implementing the structural
 * {@link PostgresPoolLike} seam that records every statement, exercising the
 * real executor without requiring a running Postgres server.
 */
import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  attachPgPoolErrorLogger,
  createPostgresRawSqlExecutor,
  type PostgresPoolClientLike,
  type PostgresPoolLike,
  type PostgresQueryResultLike,
} from '../raw-sql.js';

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
