/**
 * Self-test for the conformance harness.
 *
 * Verifies that the harness itself is correctly wired: dialect branding,
 * migration application, schema isolation, sibling client visibility, and
 * cleanup. Run on both SQLite and Postgres via `describeStorageConformance`.
 */
import * as fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, expect, it, describe } from 'vitest';
import { getDatabaseDialect, getRawSqlExecutor, resolveSchema } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { getMigrationsFolder, readMigrations } from '@makaio/storage-migrations';
import { resolveDefaultMigrationsTable } from '@makaio/storage-migrations/apply-migrations';
import { describeStorageConformance, STORAGE_TEST_URL_ENV } from '../harness/env.js';
import { ensurePostgresEngineRegistered } from '../harness/postgres-config.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { readCentralChain } from '../harness/chains.js';
import { fixtureKv, fixtureKvDdl } from '../harness/fixture-table.js';
import type { StorageConformanceConfig } from '../harness/config.js';

// The dialect-guard cases below exercise the 'postgres' chain folder and
// journal guard on BOTH dialect legs; those mechanics resolve through the
// engine registry, so register the Postgres engine eagerly (idempotent).
ensurePostgresEngineRegistered();

/**
 * Query `information_schema.schemata` for one schema name via a short-lived
 * admin client, closing the client on all paths (a throwing query must not
 * leak a live pool that holds the test process open).
 * @param baseUrl - Postgres connection URL for the admin client.
 * @param schemaName - Schema name to look up.
 * @returns Matching schemata rows (empty when the schema does not exist).
 */
async function querySchemata(baseUrl: string, schemaName: string): Promise<Array<{ schema_name: string }>> {
  const admin = await createDatabaseClient({ url: baseUrl });
  try {
    return await getRawSqlExecutor(admin.db).all<{ schema_name: string }>(
      sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${schemaName}`,
    );
  } finally {
    await admin.close();
  }
}

describeStorageConformance('storage conformance harness', (config: StorageConformanceConfig) => {
  // ── (1) branded handle and executor dialect ──────────────────────────────

  describe('branded handle', () => {
    const getCtx = useSuiteDatabaseContext(config);

    it('getDatabaseDialect(db) matches config.dialect', () => {
      expect(getDatabaseDialect(getCtx().db)).toBe(config.dialect);
    });

    it('executor.dialect matches config.dialect', () => {
      expect(getCtx().executor.dialect).toBe(config.dialect);
    });
  });

  // ── (2) central chain applied ────────────────────────────────────────────

  describe('central chain applied', () => {
    const getCtx = useSuiteDatabaseContext(config);

    it('ledger table contains exactly readCentralChain entries', async () => {
      const chain = readCentralChain(config.dialect);
      const ledgerTable = resolveDefaultMigrationsTable(config.dialect);
      const rows = await getCtx().executor.all<{ hash: string }>(sql.raw(`SELECT hash FROM "${ledgerTable}"`));
      expect(rows).toHaveLength(chain.length);
    });

    it('sessions table is queryable and empty', async () => {
      const rows = await getCtx().executor.all(sql`SELECT * FROM sessions`);
      expect(rows).toEqual([]);
    });
  });

  // ── (3) schema isolation ─────────────────────────────────────────────────

  describe('isolation: two contexts do not share data', () => {
    // Two independent contexts; each helper owns its own guarded lifecycle, so
    // a provisioning failure of one cannot leak the other.
    const getCtxA = useSuiteDatabaseContext(config);
    const getCtxB = useSuiteDatabaseContext(config);

    beforeAll(async () => {
      const ctxA = getCtxA();
      const ctxB = getCtxB();

      // Create the fixture table in both contexts.
      await ctxA.executor.run(sql.raw(fixtureKvDdl(config.dialect)));
      await ctxB.executor.run(sql.raw(fixtureKvDdl(config.dialect)));

      // Insert one row in context A via drizzle (uses resolveSchema).
      const tablesA = resolveSchema(ctxA.db, fixtureKv);
      await ctxA.db.insert(tablesA.kv).values({ id: 'a', label: 'context-a', payload: { src: 'a' } });

      // Insert a different row in context B.
      const tablesB = resolveSchema(ctxB.db, fixtureKv);
      await ctxB.db.insert(tablesB.kv).values({ id: 'b', label: 'context-b', payload: { src: 'b' } });
    });

    it('context A sees only its own row', async () => {
      const ctxA = getCtxA();
      const tablesA = resolveSchema(ctxA.db, fixtureKv);
      const rows = await ctxA.db.select().from(tablesA.kv);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('a');
    });

    it('context B sees only its own row', async () => {
      const ctxB = getCtxB();
      const tablesB = resolveSchema(ctxB.db, fixtureKv);
      const rows = await ctxB.db.select().from(tablesB.kv);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('b');
    });
  });

  // ── (4) sibling client visibility ────────────────────────────────────────

  describe('sibling client sees data written by primary', () => {
    const getCtx = useSuiteDatabaseContext(config);

    beforeAll(async () => {
      const ctx = getCtx();
      await ctx.executor.run(sql.raw(fixtureKvDdl(config.dialect)));

      const tables = resolveSchema(ctx.db, fixtureKv);
      await ctx.db.insert(tables.kv).values({ id: 'primary-row', label: 'written by primary', payload: {} });
    });

    it('sibling executor can read the row inserted by primary', async () => {
      const sibling = await getCtx().createSiblingClient();
      try {
        const rows = await sibling.executor.all<{ id: string }>(sql`SELECT id FROM conformance_kv`);
        expect(rows.map((r) => r.id)).toContain('primary-row');
      } finally {
        await sibling.close();
      }
    });

    // Postgres-only: the harness-owned search_path pin must supersede a
    // caller-provided sibling setting — otherwise a sibling could silently
    // escape its isolation schema and bleed data across contexts.
    const itPg = config.dialect === 'postgres' ? it : it.skip;

    itPg('sibling postgresSettings cannot override the search_path schema pin', async () => {
      const ctx = getCtx();
      const sibling = await ctx.createSiblingClient({ postgresSettings: { search_path: 'public' } });
      try {
        const [siblingRows, primaryRows] = await Promise.all([
          sibling.executor.all<{ current_schema: string }>(sql`SELECT current_schema()`),
          ctx.executor.all<{ current_schema: string }>(sql`SELECT current_schema()`),
        ]);
        expect(siblingRows[0]?.current_schema).toMatch(/^conformance_/);
        expect(siblingRows[0]?.current_schema).toBe(primaryRows[0]?.current_schema);
      } finally {
        await sibling.close();
      }
    });
  });

  // ── (5) cleanup leaves no artifacts ─────────────────────────────────────

  describe('cleanup', () => {
    // Dialect-gated: each leg verifies its own isolation unit is destroyed.
    const describePg = config.dialect === 'postgres' ? describe : describe.skip;
    const describeSqlite = config.dialect === 'sqlite' ? describe : describe.skip;

    describeSqlite('sqlite: db file is gone after cleanup', () => {
      it('unlinks the database file and its WAL/SHM companions', async () => {
        const ctx = await config.createDatabaseContext({ applyCentralChain: false });

        // Capture the actual backing file path while the connection is live.
        const rows = await ctx.executor.all<{ file: string }>(
          sql`SELECT file FROM pragma_database_list WHERE name = 'main'`,
        );
        const file = rows[0]?.file;
        expect(typeof file).toBe('string');
        expect(fs.existsSync(file!)).toBe(true);

        await ctx.cleanup();

        for (const suffix of ['', '-wal', '-shm']) {
          expect(fs.existsSync(`${file}${suffix}`), `${file}${suffix} must be gone after cleanup()`).toBe(false);
        }
      });
    });

    describePg('postgres: schema is removed after cleanup', () => {
      it('information_schema.schemata no longer contains the schema after cleanup', async () => {
        const baseUrl = process.env[STORAGE_TEST_URL_ENV]!;
        const ctx = await config.createDatabaseContext({ applyCentralChain: false });

        // Capture the schema name while the connection is still alive.
        const schemaRows = await ctx.executor.all<{ current_schema: string }>(sql`SELECT current_schema()`);
        const schemaName = schemaRows[0]?.current_schema;
        expect(typeof schemaName).toBe('string');

        // Verify the schema exists before cleanup via an admin client.
        expect(await querySchemata(baseUrl, schemaName!)).toHaveLength(1);

        // Run cleanup — closes pool and DROPs the schema.
        await ctx.cleanup();

        // Verify the schema is gone via a fresh admin client.
        expect(await querySchemata(baseUrl, schemaName!)).toHaveLength(0);
      });
    });
  });

  // ── (6) readCentralChain dialect mismatch throws MigrationDialectMismatchError ──

  describe('readCentralChain dialect guard', () => {
    it('throws MigrationDialectMismatchError when postgres dir fed to sqlite expectedDialect', () => {
      expect(() =>
        readMigrations({
          migrationsDir: getMigrationsFolder('postgres'),
          expectedDialect: 'sqlite',
        }),
      ).toThrow(expect.objectContaining({ name: 'MigrationDialectMismatchError' }));
    });

    it('throws MigrationDialectMismatchError when sqlite dir fed to postgres expectedDialect', () => {
      expect(() =>
        readMigrations({
          migrationsDir: getMigrationsFolder('sqlite'),
          expectedDialect: 'postgres',
        }),
      ).toThrow(expect.objectContaining({ name: 'MigrationDialectMismatchError' }));
    });
  });
});
