/**
 * Tests for runBootExtensionMigrations dialect-mismatch handling and
 * per-dialect chain selection via migrationsPathByDialect.
 *
 * Two categories:
 * 1. Real SQLite path — exercises the full migration pipeline against a
 *    temporary file-backed database, pinning ledger naming invariants.
 * 2. PG-branded handle path — verifies the dialect-mismatch
 *    wrapper and Postgres chain selection without requiring 'pg' to be
 *    installed.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { runBootExtensionMigrations } from '../boot-extension-migrations.js';

// ---------------------------------------------------------------------------
// Minimal SQLite extension fixture
// ---------------------------------------------------------------------------

const SQLITE_JOURNAL = JSON.stringify({
  version: '6',
  dialect: 'sqlite',
  entries: [
    {
      idx: 0,
      when: 1700000000000,
      tag: '0000_test',
      breakpoints: true,
    },
  ],
});

const SQLITE_MIGRATION_SQL = 'CREATE TABLE ext_demo (id TEXT PRIMARY KEY);';

/**
 * Create a temporary directory containing a minimal SQLite Drizzle migration
 * chain (meta/_journal.json + 0000_test.sql) and return its path.
 * @returns Absolute path to the migrations directory.
 */
function createSqliteExtensionFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-ext-migrations-'));
  const metaDir = path.join(dir, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, '_journal.json'), SQLITE_JOURNAL, 'utf8');
  fs.writeFileSync(path.join(dir, '0000_test.sql'), SQLITE_MIGRATION_SQL, 'utf8');
  return dir;
}

const POSTGRES_JOURNAL = JSON.stringify({
  version: '7',
  dialect: 'postgresql',
  entries: [
    {
      idx: 0,
      when: 1700000000000,
      tag: '0000_pg_test',
      breakpoints: true,
    },
  ],
});

const POSTGRES_MIGRATION_SQL = 'CREATE TABLE ext_demo_pg (id TEXT PRIMARY KEY);';

/**
 * Create a temporary directory containing a minimal Postgres Drizzle migration
 * chain (meta/_journal.json + 0000_pg_test.sql) and return its path.
 * @returns Absolute path to the migrations directory.
 */
function createPostgresExtensionFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-ext-migrations-pg-'));
  const metaDir = path.join(dir, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, '_journal.json'), POSTGRES_JOURNAL, 'utf8');
  fs.writeFileSync(path.join(dir, '0000_pg_test.sql'), POSTGRES_MIGRATION_SQL, 'utf8');
  return dir;
}

/**
 * Remove a temporary directory tree.
 * @param dir - Directory to remove.
 */
function removeTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runBootExtensionMigrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createSqliteExtensionFixture();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('applies sqlite extension chains and keeps the historical ledger name', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    try {
      await runBootExtensionMigrations(db, [
        {
          name: 'demo-ext',
          migrationsPath: tmpDir,
          migrationSourceId: 'demo-src',
        },
      ]);

      const rawSql = getRawSqlExecutor(db);

      // The extension table declared in the migration SQL must exist.
      const extTable = await rawSql.all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'ext_demo'
      `);
      expect(extTable).toHaveLength(1);

      // The ledger table name must be the established __drizzle_migrations_<sha256-16>
      // format — renaming this would break every installed database.
      const expectedLedger =
        '__drizzle_migrations_' + createHash('sha256').update('demo-src').digest('hex').slice(0, 16);
      const ledgerTable = await rawSql.all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = ${expectedLedger}
      `);
      expect(ledgerTable).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('wraps dialect mismatches into an actionable per-extension error', async () => {
    const { db } = await createPgBrandedTestDb();

    await expect(
      runBootExtensionMigrations(db, [
        {
          name: 'demo-ext',
          migrationsPath: tmpDir,
          migrationSourceId: 'demo-src',
        },
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes("Extension 'demo-ext'") &&
        err.message.includes("'postgres'") &&
        err.message.includes('Disable this extension') &&
        err.cause instanceof Error &&
        (err.cause as Error).name === 'MigrationDialectMismatchError'
      );
    });
  });

  it('rethrows non-mismatch read failures unchanged', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    try {
      const nonexistentPath = path.join(os.tmpdir(), `makaio-nonexistent-${randomUUID()}`);

      await expect(
        runBootExtensionMigrations(db, [
          {
            name: 'missing-ext',
            migrationsPath: nonexistentPath,
            migrationSourceId: 'missing-src',
          },
        ]),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof Error)) return false;
        return (
          err.message.includes('Cannot find migrations journal') && !err.message.includes('Disable this extension')
        );
      });
    } finally {
      await close();
    }
  });

  it('selects migrationsPathByDialect.postgres over migrationsPath on a postgres handle', async () => {
    const { db, statements } = await createPgBrandedTestDb();
    const pgDir = createPostgresExtensionFixture();
    try {
      // migrationsPath points at the SQLite chain — if the per-dialect
      // override were ignored, this run would fail with the dialect-mismatch
      // wrapper instead of applying the Postgres chain.
      await runBootExtensionMigrations(db, [
        {
          name: 'demo-ext',
          migrationsPath: tmpDir,
          migrationSourceId: 'demo-src',
          migrationsPathByDialect: { postgres: pgDir },
        },
      ]);

      const joined = statements.join('\n');
      expect(joined).toContain('CREATE TABLE ext_demo_pg');

      // D11: the Postgres engine names extension ledgers
      // __makaio_migrations_<sha256-16>. The rename is unobservable in any
      // installed database — Postgres hosts hard-failed SQLite extension
      // chains at the journal-dialect guard before any ledger DDL ran.
      const expectedPgLedger =
        '__makaio_migrations_' + createHash('sha256').update('demo-src').digest('hex').slice(0, 16);
      expect(joined).toContain(expectedPgLedger);
      expect(joined).not.toContain('__drizzle_migrations_');
    } finally {
      removeTmpDir(pgDir);
    }
  });

  it('falls back to migrationsPath when migrationsPathByDialect has no entry for the dialect', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    try {
      // Only a postgres override is declared; on a sqlite handle the runner
      // must fall back to migrationsPath instead of failing or skipping.
      await runBootExtensionMigrations(db, [
        {
          name: 'demo-ext',
          migrationsPath: tmpDir,
          migrationSourceId: 'demo-src',
          migrationsPathByDialect: { postgres: path.join(os.tmpdir(), `makaio-unused-${randomUUID()}`) },
        },
      ]);

      const rawSql = getRawSqlExecutor(db);
      const extTable = await rawSql.all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'ext_demo'
      `);
      expect(extTable).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // -------------------------------------------------------------------------
  // End-to-end production path: a manifest object form
  // ({ sqlite, postgres }) flows through the kernel into the boot callback,
  // and the active dialect picks its own chain and engine-owned ledger. These
  // assert the full object form on each host — distinct from the partial
  // single-entry cases above.
  // -------------------------------------------------------------------------

  it('object-form: sqlite host applies the sqlite chain and keeps the historical ledger', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const pgDir = createPostgresExtensionFixture();
    try {
      // Both dialects are declared; on a sqlite handle the runner must select
      // the sqlite entry and ignore the postgres one.
      await runBootExtensionMigrations(db, [
        {
          name: 'demo-ext',
          migrationsPath: tmpDir,
          migrationSourceId: 'demo-src',
          migrationsPathByDialect: { sqlite: tmpDir, postgres: pgDir },
        },
      ]);

      const rawSql = getRawSqlExecutor(db);

      // The sqlite chain's table — not the postgres chain's ext_demo_pg.
      const extTable = await rawSql.all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'ext_demo'
      `);
      expect(extTable).toHaveLength(1);

      // The historical __drizzle_migrations_<sha256-16> ledger — renaming this
      // would break every installed sqlite database.
      const expectedLedger =
        '__drizzle_migrations_' + createHash('sha256').update('demo-src').digest('hex').slice(0, 16);
      const ledgerTable = await rawSql.all<{ name: string }>(sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = ${expectedLedger}
      `);
      expect(ledgerTable).toHaveLength(1);
    } finally {
      removeTmpDir(pgDir);
      await close();
    }
  });

  it('object-form: postgres host applies the postgres chain and the engine-owned __makaio_migrations ledger', async () => {
    const { db, statements } = await createPgBrandedTestDb();
    const pgDir = createPostgresExtensionFixture();
    try {
      // Both dialects are declared; on a postgres handle the runner must select
      // the postgres entry and ignore the sqlite one (migrationsPath/tmpDir).
      await runBootExtensionMigrations(db, [
        {
          name: 'demo-ext',
          migrationsPath: tmpDir,
          migrationSourceId: 'demo-src',
          migrationsPathByDialect: { sqlite: tmpDir, postgres: pgDir },
        },
      ]);

      const joined = statements.join('\n');
      expect(joined).toContain('CREATE TABLE ext_demo_pg');

      // The Postgres engine names extension ledgers
      // __makaio_migrations_<sha256-16> and never the SQLite ledger.
      const expectedPgLedger =
        '__makaio_migrations_' + createHash('sha256').update('demo-src').digest('hex').slice(0, 16);
      expect(joined).toContain(expectedPgLedger);
      expect(joined).not.toContain('__drizzle_migrations_');
    } finally {
      removeTmpDir(pgDir);
    }
  });

  it('object-form without a sqlite entry on a sqlite host falls back to migrationsPath and fails loud at the journal-dialect guard', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const pgDir = createPostgresExtensionFixture();
    try {
      // No sqlite entry; the singular fallback points at the postgres chain.
      // On a sqlite handle the runner falls back to migrationsPath (the
      // postgres chain) and the journal-dialect guard must fail loud with the
      // actionable per-extension wrapper instead of silently skipping.
      await expect(
        runBootExtensionMigrations(db, [
          {
            name: 'demo-ext',
            migrationsPath: pgDir,
            migrationSourceId: 'demo-src',
            migrationsPathByDialect: { postgres: pgDir },
          },
        ]),
      ).rejects.toSatisfy((err: unknown) => {
        if (!(err instanceof Error)) return false;
        return (
          err.message.includes("Extension 'demo-ext'") &&
          err.message.includes("'sqlite'") &&
          err.message.includes('Disable this extension') &&
          err.cause instanceof Error &&
          (err.cause as Error).name === 'MigrationDialectMismatchError'
        );
      });
    } finally {
      removeTmpDir(pgDir);
      await close();
    }
  });
});
