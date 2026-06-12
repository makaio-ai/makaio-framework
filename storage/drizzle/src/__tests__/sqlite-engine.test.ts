/**
 * Tests for the built-in SQLite storage engine.
 *
 * Behavior assertions run against real in-memory databases created through
 * the engine's own client factory — no mocks. The migration-behavior strings
 * are byte-pins: they are cross-version contracts that must keep matching
 * ledgers written by earlier framework versions.
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { sqliteStorageEngine } from '../engine/sqlite/engine';
import { quoteSqlIdentifier } from '../engine/types';
import { getRawSqlExecutor } from '../raw-sql';

describe('sqliteStorageEngine identity', () => {
  it('declares the sqlite dialect and no URL claim (default engine)', () => {
    expect(sqliteStorageEngine.dialect).toBe('sqlite');
    // The default engine serves every URL no registered engine claims, so it
    // deliberately declares no matchesUrl.
    expect(sqliteStorageEngine.matchesUrl).toBeUndefined();
  });
});

describe('sqliteStorageEngine.createClient', () => {
  it('round-trips a simple statement on an in-memory database', async () => {
    const client = await sqliteStorageEngine.createClient({ url: ':memory:' });
    try {
      expect(client.dialect).toBe('sqlite');
      const rows = await getRawSqlExecutor(client.db).all<{ val: number }>(sql`SELECT 1 AS val`);
      expect(rows).toEqual([{ val: 1 }]);
    } finally {
      await client.close();
    }
  });
});

describe('sqliteStorageEngine.capabilities', () => {
  it('exposes BLOB as the binary column type and no counter-assignment races', () => {
    expect(sqliteStorageEngine.capabilities.binaryColumnType).toBe('BLOB');
    expect(sqliteStorageEngine.capabilities.maxCounterAssignmentRaces).toBe(false);
  });

  it('tableExists probes the real sqlite_master catalog', async () => {
    const client = await sqliteStorageEngine.createClient({ url: ':memory:' });
    try {
      const executor = getRawSqlExecutor(client.db);
      expect(await sqliteStorageEngine.capabilities.tableExists(executor, 'probe_target')).toBe(false);

      await executor.run(sql.raw('CREATE TABLE probe_target (id INTEGER PRIMARY KEY)'));

      expect(await sqliteStorageEngine.capabilities.tableExists(executor, 'probe_target')).toBe(true);
      expect(await sqliteStorageEngine.capabilities.tableExists(executor, 'still_missing')).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe('sqliteStorageEngine.errors', () => {
  it('classifies duplicate-object errors by message text', () => {
    expect(sqliteStorageEngine.errors.isDuplicateObjectError(new Error('table probe_target already exists'))).toBe(
      true,
    );
    expect(sqliteStorageEngine.errors.isDuplicateObjectError(new Error('no such table: probe_target'))).toBe(false);
  });

  it('classifies unique-violation errors by message text (constraint scope is a no-op)', () => {
    const violation = new Error('UNIQUE constraint failed: turns.session_id, turns.turn_number');
    expect(sqliteStorageEngine.errors.isUniqueViolationError(violation)).toBe(true);
    // SQLite errors carry the violated column list, not a constraint name —
    // the optional scope only narrows matches on engines that report names.
    expect(sqliteStorageEngine.errors.isUniqueViolationError(violation, 'turns_session_turn_unique')).toBe(true);
    expect(sqliteStorageEngine.errors.isUniqueViolationError(new Error('database is locked'))).toBe(false);
  });
});

describe('sqliteStorageEngine.migrations (cross-version byte-pins)', () => {
  it('keeps the historical Drizzle ledger defaults', () => {
    expect(sqliteStorageEngine.migrations.defaultLedgerTable).toBe('__drizzle_migrations');
    expect(sqliteStorageEngine.migrations.journalDialect).toBe('sqlite');
    expect(sqliteStorageEngine.migrations.chainDirName).toBe('drizzle');
  });

  it('pins the ledger DDL to the historical Drizzle shape, byte for byte', () => {
    expect(sqliteStorageEngine.migrations.buildLedgerDdl('__drizzle_migrations')).toBe(
      'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (\n' +
        '      id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
        '      hash text NOT NULL,\n' +
        '      created_at numeric\n' +
        '    )',
    );
  });

  it('escapes embedded quotes in the ledger table identifier', () => {
    expect(quoteSqlIdentifier('we"ird')).toBe('"we""ird"');
    expect(sqliteStorageEngine.migrations.buildLedgerDdl('we"ird')).toContain('CREATE TABLE IF NOT EXISTS "we""ird"');
  });

  it('keeps the bare historical BEGIN and declares no cross-process lock protocol', () => {
    expect(sqliteStorageEngine.migrations.beginTransactionStatement).toBe('BEGIN');
    // SQLite writes serialize at the connection level: no acquireTransactionLock
    // means the applicator skips the locked snapshot and in-lock recheck.
    expect(sqliteStorageEngine.migrations.acquireTransactionLock).toBeUndefined();
    expect(sqliteStorageEngine.migrations.resolveSourceChainDir).toBeUndefined();
  });

  it('derives extension ledger names with the established sqlite prefix', () => {
    expect(sqliteStorageEngine.migrations.extensionLedgerName('0123456789abcdef')).toBe(
      '__drizzle_migrations_0123456789abcdef',
    );
  });
});
