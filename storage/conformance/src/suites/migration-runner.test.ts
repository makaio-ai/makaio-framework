/**
 * Migration-runner conformance suite — both dialects.
 *
 * Covers application, idempotence, hash-based dedup, abort-aware adoption,
 * multi-statement adoption rejection, failing-migration rollback, and
 * custom ledger table naming. Runs against whichever dialect the
 * environment selects (SQLite by default; Postgres when
 * MAKAIO_STORAGE_TEST_DIALECT=postgres + MAKAIO_STORAGE_TEST_URL are set).
 *
 * Each case uses a unique fixture table name so tests are parallel-safe
 * within the file. Postgres schema isolation keeps them parallel-safe
 * across suite files.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applyMigrations, resolveDefaultMigrationsTable } from '@makaio/storage-migrations/apply-migrations';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { fixtureMigration } from '../harness/fixture-migrations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Probe whether a table exists in the database.
 * On SQLite we query sqlite_master; on Postgres we use to_regclass.
 * @param ctx - Active database context.
 * @param tableName - Unqualified table name to probe.
 * @returns True when the table exists.
 */
async function tableExists(ctx: StorageDatabaseContext, tableName: string): Promise<boolean> {
  if (ctx.dialect === 'postgres') {
    const rows = await ctx.executor.all<{ exists: string | null }>(sql`SELECT to_regclass(${tableName}) AS exists`);
    return rows[0]?.exists !== null;
  }
  const rows = await ctx.executor.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tableName}`,
  );
  return rows.length > 0;
}

/**
 * Fetch hashes from the default migration ledger for the context dialect.
 * @param ctx - Active database context.
 * @returns All hash strings currently in the ledger.
 */
async function readLedgerHashes(ctx: StorageDatabaseContext): Promise<string[]> {
  const ledger = resolveDefaultMigrationsTable(ctx.dialect);
  const ledgerId = sql.identifier(ledger);
  const rows = await ctx.executor.all<{ hash: string }>(sql`SELECT hash FROM ${ledgerId} ORDER BY hash ASC`);
  return rows.map((r) => r.hash);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('migration-runner', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });

  // -------------------------------------------------------------------------
  // Case 1: Application and idempotence
  // -------------------------------------------------------------------------
  describe('application and idempotence', () => {
    const m1 = fixtureMigration(
      '0001_apply_idempotent',
      ['CREATE TABLE mig_apply_t1 (id text PRIMARY KEY, label text)'],
      0,
    );
    const m2 = fixtureMigration(
      '0002_apply_idempotent',
      ['CREATE TABLE mig_apply_t2 (id text PRIMARY KEY, val text)'],
      1,
    );

    it('applies two migrations and both tables exist', async () => {
      const ctx = getCtx();
      await applyMigrations(ctx.db, [m1, m2]);
      expect(await tableExists(ctx, 'mig_apply_t1')).toBe(true);
      expect(await tableExists(ctx, 'mig_apply_t2')).toBe(true);
    });

    it('second applyMigrations call with the same array is a no-op', async () => {
      // Should not throw (no duplicate table errors, no duplicate ledger rows).
      await applyMigrations(getCtx().db, [m1, m2]);
    });

    it('ledger holds exactly 2 rows with correct hashes', async () => {
      const hashes = await readLedgerHashes(getCtx());
      expect(hashes).toHaveLength(2);
      expect(hashes).toContain(m1.hash);
      expect(hashes).toContain(m2.hash);
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: Ledger dedup is by hash, not by timestamp
  // -------------------------------------------------------------------------
  describe('ledger dedup by hash not timestamp', () => {
    const mFirst = fixtureMigration('0001_dedup_first', ['CREATE TABLE mig_dedup_t1 (id text PRIMARY KEY)'], 10);
    // mEarlier has a SMALLER folderMillis (order -1 → 1700000000000 - 1 < mFirst's)
    const mEarlier = fixtureMigration('0000_dedup_earlier', ['CREATE TABLE mig_dedup_t0 (id text PRIMARY KEY)'], -1);

    it('mEarlier (smaller folderMillis) is still applied when its hash is not in the ledger', async () => {
      const ctx = getCtx();
      await applyMigrations(ctx.db, [mFirst]);
      // Now apply [mFirst, mEarlier]: mEarlier's hash is not yet recorded,
      // so it must be applied regardless of the timestamp ordering.
      await applyMigrations(ctx.db, [mFirst, mEarlier]);

      expect(await tableExists(ctx, 'mig_dedup_t1')).toBe(true);
      expect(await tableExists(ctx, 'mig_dedup_t0')).toBe(true);

      // Both hashes must be recorded in the ledger exactly once each.
      const ledger = resolveDefaultMigrationsTable(ctx.dialect);
      const ledgerId = sql.identifier(ledger);
      const firstRows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mFirst.hash}`,
      );
      const earlierRows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mEarlier.hash}`,
      );
      expect(firstRows).toHaveLength(1);
      expect(earlierRows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: Abort-aware adoption (single-statement CREATE already exists)
  // -------------------------------------------------------------------------
  describe('abort-aware adoption', () => {
    const adoptDdl = 'CREATE TABLE mig_adopt_t1 (id text PRIMARY KEY, note text)';
    const mAdopt = fixtureMigration('0001_adopt', [adoptDdl], 20);

    it('pre-creates the table and adoption resolves, recording the hash', async () => {
      const ctx = getCtx();
      // Pre-create outside the migration runner.
      await ctx.executor.run(sql.raw(adoptDdl));

      // The runner must detect the duplicate-object error, adopt, and record.
      await applyMigrations(ctx.db, [mAdopt]);

      const ledger = resolveDefaultMigrationsTable(ctx.dialect);
      const ledgerId = sql.identifier(ledger);
      const rows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mAdopt.hash}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('re-running after adoption is a clean skip (still exactly 1 ledger row for this hash)', async () => {
      const ctx = getCtx();
      await applyMigrations(ctx.db, [mAdopt]);

      const ledger = resolveDefaultMigrationsTable(ctx.dialect);
      const ledgerId = sql.identifier(ledger);
      const rows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mAdopt.hash}`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Multi-statement adoption rejection
  // -------------------------------------------------------------------------
  describe('multi-statement adoption rejection', () => {
    const existingDdl = 'CREATE TABLE mig_multi_adopt_t1 (id text PRIMARY KEY)';
    const newTableDdl = 'CREATE TABLE mig_multi_adopt_t2 (id text PRIMARY KEY)';
    const mMulti = fixtureMigration('0001_multi_adopt', [existingDdl, newTableDdl], 30);

    it('rejects with "Cannot adopt multi-statement migration" and includes the tag', async () => {
      const ctx = getCtx();
      // Pre-create only the first table.
      await ctx.executor.run(sql.raw(existingDdl));

      await expect(applyMigrations(ctx.db, [mMulti])).rejects.toThrow(
        /Cannot adopt multi-statement migration.*0001_multi_adopt/,
      );
    });

    it('leaves no ledger row for the rejected migration', async () => {
      const ctx = getCtx();
      const ledger = resolveDefaultMigrationsTable(ctx.dialect);
      const ledgerId = sql.identifier(ledger);
      const rows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mMulti.hash}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('the second statement table was NOT created', async () => {
      expect(await tableExists(getCtx(), 'mig_multi_adopt_t2')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: Failing-migration rollback
  // -------------------------------------------------------------------------
  describe('failing-migration rollback', () => {
    const mFailing = fixtureMigration('0001_rollback_test', ['CREATE TABLE roll_t (id text)', 'THIS IS NOT SQL'], 40);
    const mValid = fixtureMigration('0002_after_rollback', ['CREATE TABLE roll_after_t (id text PRIMARY KEY)'], 41);

    it('rejects the failing migration', async () => {
      await expect(applyMigrations(getCtx().db, [mFailing])).rejects.toThrow();
    });

    it('roll_t does NOT exist after rollback (transactional DDL)', async () => {
      expect(await tableExists(getCtx(), 'roll_t')).toBe(false);
    });

    it('ledger has no row for the failed migration', async () => {
      const ctx = getCtx();
      const ledger = resolveDefaultMigrationsTable(ctx.dialect);
      const ledgerId = sql.identifier(ledger);
      const rows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${ledgerId} WHERE hash = ${mFailing.hash}`,
      );
      expect(rows).toHaveLength(0);
    });

    it('client is not poisoned: a subsequent valid migration succeeds', async () => {
      const ctx = getCtx();
      await applyMigrations(ctx.db, [mValid]);
      expect(await tableExists(ctx, 'roll_after_t')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: Custom migrationsTable parameter
  // -------------------------------------------------------------------------
  describe('custom migrationsTable parameter', () => {
    const customLedger = '__conformance_runner_ledger';
    const mCustom = fixtureMigration(
      '0001_custom_ledger',
      ['CREATE TABLE mig_custom_ledger_t1 (id text PRIMARY KEY)'],
      50,
    );

    it('rows land in the custom ledger, not the dialect default', async () => {
      const ctx = getCtx();
      await applyMigrations(ctx.db, [mCustom], customLedger);

      const customId = sql.identifier(customLedger);
      const customRows = await ctx.executor.all<{ hash: string }>(sql`SELECT hash FROM ${customId}`);
      expect(customRows).toHaveLength(1);
      expect(customRows[0]!.hash).toBe(mCustom.hash);
    });

    it('the dialect default ledger table does NOT get the custom migration row', async () => {
      const ctx = getCtx();
      const defaultLedger = resolveDefaultMigrationsTable(ctx.dialect);
      const defaultId = sql.identifier(defaultLedger);
      const defaultRows = await ctx.executor.all<{ hash: string }>(
        sql`SELECT hash FROM ${defaultId} WHERE hash = ${mCustom.hash}`,
      );
      expect(defaultRows).toHaveLength(0);
    });
  });
});
