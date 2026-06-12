import { describe, expect, it } from 'vitest';
import * as storageDrizzle from '../index';

describe('@makaio/storage-drizzle main entry', () => {
  it('does not expose the runtime-specific database client factory', () => {
    expect('createDatabaseClient' in storageDrizzle).toBe(false);
  });

  it('does not expose createPostgresRawSqlExecutor (kept off the barrel, mirrors createSqliteRawSqlExecutor)', () => {
    expect('createPostgresRawSqlExecutor' in storageDrizzle).toBe(false);
  });

  it('exports cross-driver write-result helpers', () => {
    expect(storageDrizzle.didAffectRows({ rowsAffected: 1 })).toBe(true);
    expect(storageDrizzle.didAffectRows({ rowsAffected: 0 })).toBe(false);
    expect(storageDrizzle.didAffectRows({ changes: 1 })).toBe(true);
    expect(storageDrizzle.didAffectRows({ changes: 0 })).toBe(false);
    expect(storageDrizzle.didAffectRows({ rowCount: 1 })).toBe(true);
    expect(storageDrizzle.didAffectRows({ rowCount: 0 })).toBe(false);
  });

  it('normalises affected row counts across supported driver result shapes', () => {
    expect(storageDrizzle.affectedRowCount({ rowsAffected: 2 })).toBe(2);
    expect(storageDrizzle.affectedRowCount({ changes: 3 })).toBe(3);
    expect(storageDrizzle.affectedRowCount({ rowsAffected: null, changes: 4 })).toBe(4);
    expect(storageDrizzle.affectedRowCount({ rowsAffected: 2, changes: 3 })).toBe(2);
    expect(storageDrizzle.affectedRowCount({})).toBe(0);
    expect(storageDrizzle.affectedRowCount({ rowsAffected: undefined, changes: undefined })).toBe(0);
  });

  it('resolves rowCount when rowsAffected and changes are absent or null', () => {
    expect(storageDrizzle.affectedRowCount({ rowCount: 5 })).toBe(5);
    expect(storageDrizzle.affectedRowCount({ rowsAffected: null, changes: null, rowCount: 6 })).toBe(6);
    expect(storageDrizzle.affectedRowCount({ changes: 3, rowCount: 6 })).toBe(3);
    expect(storageDrizzle.affectedRowCount({ rowCount: null })).toBe(0);
  });

  it('exports the storage dialect brand key and reader', () => {
    // Symbol.for is load-bearing: duplicated module instances must resolve
    // the same brand through the global symbol registry.
    expect(storageDrizzle.DATABASE_DIALECT).toBe(Symbol.for('makaio.storage.dialect'));
    expect(typeof storageDrizzle.getDatabaseDialect).toBe('function');
  });
});
