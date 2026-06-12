import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStorageEngine } from '@makaio/storage-drizzle';
import { storageEngine as postgresStorageEngine } from '@makaio/storage-pg';
import { MigrationDialectMismatchError, readMigrations } from '../read-migrations.js';

// The journal-dialect guard and the default chain folder resolve through the
// engine registry; register the Postgres engine so the 'postgres' paths under
// test are served by the real engine (same-reference re-registration is a
// no-op).
registerStorageEngine(postgresStorageEngine);

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Write a minimal migration directory fixture.
 * @param journalDialect - `dialect` value to record in the journal; omitted
 *   from the journal entirely when `undefined`.
 * @returns Absolute path of the created `drizzle/` directory.
 */
function createMigrationDir(journalDialect?: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'makaio-read-migrations-'));
  tempDirs.push(root);
  const migrationsDir = path.join(root, 'drizzle');
  mkdirSync(path.join(migrationsDir, 'meta'), { recursive: true });
  writeFileSync(
    path.join(migrationsDir, 'meta', '_journal.json'),
    JSON.stringify({
      ...(journalDialect === undefined ? {} : { dialect: journalDialect }),
      entries: [{ when: 1, tag: '0000_init', breakpoints: false }],
    }),
  );
  writeFileSync(path.join(migrationsDir, '0000_init.sql'), 'CREATE TABLE test (`id` text PRIMARY KEY NOT NULL);');
  return migrationsDir;
}

describe('readMigrations', () => {
  it('reads filesystem migrations when called with a dual-source object', () => {
    const migrationsDir = createMigrationDir();

    expect(
      readMigrations({
        migrationsDir,
        migrationSourceId: 'host/services/src/test/drizzle',
      }),
    ).toEqual([
      expect.objectContaining({
        tag: '0000_init',
        folderMillis: 1,
        sql: ['CREATE TABLE test (`id` text PRIMARY KEY NOT NULL);'],
      }),
    ]);
  });

  describe('journal dialect validation', () => {
    it('accepts a sqlite journal when expecting the sqlite dialect', () => {
      const migrationsDir = createMigrationDir('sqlite');

      expect(readMigrations({ migrationsDir, expectedDialect: 'sqlite' })).toEqual([
        expect.objectContaining({ tag: '0000_init' }),
      ]);
    });

    it("accepts a postgresql journal when expecting the postgres dialect (drizzle-kit writes 'postgresql')", () => {
      const migrationsDir = createMigrationDir('postgresql');

      expect(readMigrations({ migrationsDir, expectedDialect: 'postgres' })).toEqual([
        expect.objectContaining({ tag: '0000_init' }),
      ]);
    });

    it('rejects a sqlite journal when expecting the postgres dialect with a named, actionable error', () => {
      const migrationsDir = createMigrationDir('sqlite');
      const read = (): unknown => readMigrations({ migrationsDir, expectedDialect: 'postgres' });

      expect(read).toThrow(MigrationDialectMismatchError);
      expect(read).toThrow(/declares dialect 'sqlite'.*database speaks 'postgres'/);
      expect(read).toThrow(migrationsDir);

      try {
        read();
        expect.unreachable('readMigrations must throw on a dialect mismatch');
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationDialectMismatchError);
        if (error instanceof MigrationDialectMismatchError) {
          expect(error.name).toBe('MigrationDialectMismatchError');
          expect(error.expectedDialect).toBe('postgres');
          expect(error.journalDialect).toBe('sqlite');
        }
      }
    });

    it('rejects a postgresql journal when expecting the sqlite dialect', () => {
      const migrationsDir = createMigrationDir('postgresql');

      expect(() => readMigrations({ migrationsDir, expectedDialect: 'sqlite' })).toThrow(MigrationDialectMismatchError);
    });

    it('rejects a journal without a dialect field when an expected dialect is set', () => {
      const migrationsDir = createMigrationDir();

      expect(() => readMigrations({ migrationsDir, expectedDialect: 'sqlite' })).toThrow(MigrationDialectMismatchError);
      expect(() => readMigrations({ migrationsDir, expectedDialect: 'sqlite' })).toThrow(/declares dialect 'unknown'/);
    });

    it('skips validation when no expected dialect is provided', () => {
      const migrationsDir = createMigrationDir();

      expect(readMigrations({ migrationsDir })).toEqual([expect.objectContaining({ tag: '0000_init' })]);
    });

    it('defaults to the bundled chain matching the expected dialect', () => {
      // The filesystem default is the package-local chain generated for the
      // expected dialect, so the always-on boot guard accepts the default
      // source for both dialects — a default that the guard itself rejects
      // would make zero-config reads unusable on one dialect.
      const sqliteChain = readMigrations({ expectedDialect: 'sqlite' });
      const postgresChain = readMigrations({ expectedDialect: 'postgres' });

      expect(sqliteChain.length).toBeGreaterThan(0);
      expect(postgresChain.length).toBeGreaterThan(0);

      // The two defaults resolve distinct chains (drizzle/ vs drizzle-postgres/).
      expect(postgresChain.map((m) => m.hash)).not.toEqual(sqliteChain.map((m) => m.hash));
    });

    it('defaults to the sqlite chain when no expected dialect is given', () => {
      const defaultChain = readMigrations();
      const sqliteChain = readMigrations({ expectedDialect: 'sqlite' });

      expect(defaultChain.map((m) => m.hash)).toEqual(sqliteChain.map((m) => m.hash));
    });
  });
});
