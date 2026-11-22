/**
 * `executeTransaction` must never run a callback on a bun-sqlite handle whose
 * native `transaction()` was never bound to the async atomicity contract: a
 * hand-rolled `drizzle-orm/bun-sqlite` handle keeps drizzle's native
 * synchronous transaction, which commits at the callback's first `await`
 * instead of holding the boundary open across every awaited statement.
 *
 * These cases build a real `drizzle-orm/bun-sqlite` handle directly (not
 * through `createDatabaseClient`) to exercise the genuine
 * `SQLiteBunSession` the detection in `unbound-bun-handle.ts` keys off, rather
 * than a structural test double.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { bindBunSqliteTransactions, type BunSqliteTransactionalDatabase } from '../engine/sqlite/bun-transaction';
import { HandleGate } from '../engine/sqlite/handle-gate';
import { createHostDatabase, getTransactionQueryContext } from '../host-database';
import { executeTransaction } from '../transaction';
import type { MakaioDatabase } from '../types';

/** The table the cases create, typed for the host query context. */
const t = sqliteTable('t', { id: text('id').primaryKey() });

/** A hand-rolled bun-sqlite handle seen both as the shared handle type and as the binding's input. */
type HandRolledBunHandle = MakaioDatabase & BunSqliteTransactionalDatabase;

/**
 * View a hand-rolled bun-sqlite handle the way the SQLite client factory hands
 * one out. The single cast mirrors the factory's own (`engine/sqlite/client.ts`,
 * `db as unknown as MakaioDatabase`): drizzle's synchronous bun-sqlite database
 * and the libsql-shaped `MakaioDatabase` share the query surface but are
 * distinct types.
 * @param raw - The drizzle bun-sqlite handle built directly over a connection.
 * @returns The same handle, typed for `executeTransaction` and the binding.
 */
function asHandRolledMakaioDatabase(raw: BunSQLiteDatabase): HandRolledBunHandle {
  return raw as unknown as HandRolledBunHandle;
}

describe('executeTransaction over an unbound bun-sqlite handle', () => {
  let sqlite: Database | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it('rejects before any statement runs', async () => {
    sqlite = new Database(':memory:');
    const raw = drizzle(sqlite);
    raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    const db = asHandRolledMakaioDatabase(raw);

    await expect(
      executeTransaction(db, async (tx) => {
        await tx.run(sql`INSERT INTO t (id) VALUES ('should-not-run')`);
      }),
    ).rejects.toThrow(/createDatabaseClient/);

    expect(raw.all(sql`SELECT id FROM t`)).toEqual([]);
  });

  it('createHostDatabase rejects the same way over the same unbound handle', async () => {
    sqlite = new Database(':memory:');
    const raw = drizzle(sqlite);
    raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    const db = asHandRolledMakaioDatabase(raw);

    await expect(createHostDatabase(db).transaction(async () => undefined)).rejects.toThrow(/createDatabaseClient/);

    expect(raw.all(sql`SELECT id FROM t`)).toEqual([]);
  });

  /**
   * Build a hand-rolled handle that re-bound drizzle's native `transaction`
   * itself: an own `transaction` property that is still drizzle's synchronous
   * boundary, not the adapter.
   * @param connection - The native connection the handle is built over.
   * @returns The raw drizzle handle and its `MakaioDatabase` view.
   */
  function selfReboundHandle(connection: Database): { raw: BunSQLiteDatabase; db: HandRolledBunHandle } {
    const raw = drizzle(connection);
    raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    raw.transaction = raw.transaction.bind(raw);
    return { raw, db: asHandRolledMakaioDatabase(raw) };
  }

  it('executeTransaction rejects a handle that re-bound its native transaction itself', async () => {
    sqlite = new Database(':memory:');
    const { raw, db } = selfReboundHandle(sqlite);

    await expect(
      executeTransaction(db, async (tx) => {
        await tx.run(sql`INSERT INTO t (id) VALUES ('should-not-run')`);
      }),
    ).rejects.toThrow(/createDatabaseClient/);

    expect(raw.all(sql`SELECT id FROM t`)).toEqual([]);
  });

  it('createHostDatabase rejects a handle that re-bound its native transaction itself', async () => {
    sqlite = new Database(':memory:');
    const { raw, db } = selfReboundHandle(sqlite);

    await expect(
      createHostDatabase(db).transaction(async (tx) => {
        await getTransactionQueryContext(tx).insert(t).values({ id: 'should-not-run' });
      }),
    ).rejects.toThrow(/createDatabaseClient/);

    expect(raw.all(sql`SELECT id FROM t`)).toEqual([]);
  });

  it('accepts the same handle once bound, holding the boundary across awaits', async () => {
    sqlite = new Database(':memory:');
    const raw = drizzle(sqlite);
    raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    const db = asHandRolledMakaioDatabase(raw);
    bindBunSqliteTransactions(db, sqlite, new HandleGate());

    await executeTransaction(db, async (tx) => {
      await tx.run(sql`INSERT INTO t (id) VALUES ('committed-1')`);
      await Promise.resolve();
      await tx.run(sql`INSERT INTO t (id) VALUES ('committed-2')`);
    });

    await expect(
      executeTransaction(db, async (tx) => {
        await tx.run(sql`INSERT INTO t (id) VALUES ('rolled-back')`);
        await Promise.resolve();
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const rows = raw.all<{ id: string }>(sql`SELECT id FROM t ORDER BY id`);
    expect(rows.map((row) => row.id)).toEqual(['committed-1', 'committed-2']);
  });
});
