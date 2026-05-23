/**
 * Tests for {@link executeTransaction}.
 *
 * Uses a real SQLite database because the queue protects against driver-level
 * transaction contention, not just callback ordering.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabaseClient, type DatabaseClient } from '../client';
import { executeTransaction } from '../transaction';

describe('executeTransaction', () => {
  let openClients: DatabaseClient[] = [];
  let filesToCleanup: string[] = [];

  afterEach(() => {
    const closeErrors: unknown[] = [];
    for (const client of openClients) {
      try {
        client.close();
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
    await db.run(sql`CREATE TABLE transaction_queue_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);

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

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    const rows = await db.all<{ id: string }>(sql`SELECT id FROM transaction_queue_test ORDER BY id`);
    expect(rows.map((row) => row.id)).toEqual(['first', 'second']);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
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
