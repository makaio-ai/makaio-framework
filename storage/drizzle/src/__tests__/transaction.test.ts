/**
 * Tests for {@link executeTransaction}.
 *
 * Uses a real SQLite database because the queue protects against driver-level
 * transaction contention, not just callback ordering.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabaseClient, type DatabaseClient } from '../client';
import { brandDatabase, getRawSqlExecutor } from '../raw-sql';
import { executeTransaction, serializeDatabaseOperation } from '../transaction';

describe('executeTransaction', () => {
  let openClients: DatabaseClient[] = [];
  let filesToCleanup: string[] = [];

  afterEach(async () => {
    const closeErrors: unknown[] = [];
    for (const client of openClients) {
      try {
        await client.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    openClients = [];

    for (const dbFilePath of filesToCleanup) {
      deleteSqliteArtifacts(dbFilePath);
    }
    filesToCleanup = [];

    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, 'One or more DatabaseClient.close() calls failed during test teardown');
    }
  });

  function track(client: DatabaseClient): DatabaseClient {
    openClients.push(client);
    return client;
  }

  function trackDbFile(dbFilePath: string): string {
    filesToCleanup.push(dbFilePath);
    return dbFilePath;
  }

  it('serializes concurrent transactions on the same database connection', async () => {
    const dbFilePath = trackDbFile(path.join(os.tmpdir(), `makaio-transaction-test-${crypto.randomUUID()}.db`));
    const { db } = track(await createDatabaseClient({ url: `file:${dbFilePath}` }));
    await getRawSqlExecutor(db).run(
      sql`CREATE TABLE transaction_queue_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );

    const events: string[] = [];
    let releaseFirst = (): void => {};
    let resolveFirstStarted = (): void => {};
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const first = executeTransaction(db, async (tx) => {
      events.push('first:start');
      resolveFirstStarted();
      await new Promise<void>((release) => {
        releaseFirst = release;
      });
      await tx.run(sql`INSERT INTO transaction_queue_test (id, value) VALUES ('first', 'done')`);
      events.push('first:end');
    });

    await firstStarted;
    const second = executeTransaction(db, async (tx) => {
      events.push('second:start');
      await tx.run(sql`INSERT INTO transaction_queue_test (id, value) VALUES ('second', 'done')`);
      events.push('second:end');
    });

    try {
      await Promise.resolve();
      expect(events).toEqual(['first:start']);

      releaseFirst();
      await Promise.all([first, second]);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }

    const rows = await getRawSqlExecutor(db).all<{ id: string }>(
      sql`SELECT id FROM transaction_queue_test ORDER BY id`,
    );
    expect(rows.map((row) => row.id)).toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('serializes postgres-branded handles through the same per-handle queue', async () => {
    // Real in-memory libsql drizzle database — only the brand differs from a
    // SQLite handle. The executor view claims 'postgres' to satisfy the brand
    // consistency guard. Pins the serialization contract: a 'postgres' brand
    // must NOT bypass the queue — read-modify-write callers rely on callbacks
    // observing each other's commits, which MVCC alone does not provide.
    const rawDb = drizzle({ connection: { url: ':memory:' } });
    try {
      const db = brandDatabase(rawDb, 'postgres', { ...getRawSqlExecutor(rawDb), dialect: 'postgres' as const });

      const events: string[] = [];
      let releaseFirst = (): void => {};
      let resolveFirstStarted = (): void => {};
      const firstStarted = new Promise<void>((resolve) => {
        resolveFirstStarted = resolve;
      });
      const first = executeTransaction(db, async () => {
        events.push('first:start');
        resolveFirstStarted();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
        events.push('first:end');
      });

      await firstStarted;
      const second = executeTransaction(db, async () => {
        events.push('second:done');
      });

      // Give a hypothetical bypass ample time to start the second callback
      // while the first transaction is still open — the queue must hold it.
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        expect(events).toEqual(['first:start']);

        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second:done']);
      } finally {
        releaseFirst();
        await Promise.allSettled([first, second]);
      }
    } finally {
      rawDb.$client.close();
    }
  });

  it('serializes lifecycle-style writes with transactions on the same handle', async () => {
    const dbFilePath = trackDbFile(path.join(os.tmpdir(), `makaio-operation-test-${crypto.randomUUID()}.db`));
    const { db } = track(await createDatabaseClient({ url: `file:${dbFilePath}` }));
    await getRawSqlExecutor(db).run(sql`CREATE TABLE operation_queue_test (id TEXT PRIMARY KEY)`);

    const events: string[] = [];
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const transaction = executeTransaction(db, async (tx) => {
      events.push('transaction:start');
      started.resolve();
      await release.promise;
      await tx.run(sql`INSERT INTO operation_queue_test (id) VALUES ('transaction')`);
      events.push('transaction:end');
    });
    await started.promise;

    const projection = serializeDatabaseOperation(db, async () => {
      events.push('projection:start');
      await getRawSqlExecutor(db).run(sql`INSERT INTO operation_queue_test (id) VALUES ('projection')`);
      events.push('projection:end');
    });
    await Promise.resolve();
    expect(events).toEqual(['transaction:start']);

    release.resolve();
    await Promise.all([transaction, projection]);
    expect(events).toEqual(['transaction:start', 'transaction:end', 'projection:start', 'projection:end']);
  });
});

/**
 * Best-effort removal of a SQLite database file and its sidecars.
 * @param dbFilePath - Absolute path to the main SQLite database file.
 */
function deleteSqliteArtifacts(dbFilePath: string): void {
  for (const candidatePath of [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`]) {
    try {
      fs.unlinkSync(candidatePath);
    } catch {
      // Files may not exist if SQLite/libsql deferred creation; ignore.
    }
  }
}
