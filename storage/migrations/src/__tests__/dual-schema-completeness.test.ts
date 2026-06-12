/**
 * Anti-drift net: dual-table completeness across both discovered chains.
 *
 * `defineDualTable` produces ONE `*Dual` object holding both dialect faces, but
 * the migration chains are generated from per-dialect schema barrels: the
 * SQLite chain reads `schema.ts`, the Postgres chain reads `schema.postgres.ts`.
 * Each barrel must re-export its dialect's face under a canonical key so the
 * live-schema loader (which keeps only values passing `is(_, SQLiteTable)` /
 * `is(_, PgTable)`) sees the table. If a face is dropped from one barrel, that
 * table silently vanishes from that chain — and the live inventory's table
 * floor tolerates several missing tables, so the drop would go unnoticed.
 *
 * This test closes that gap. For every package declaring `makaio.drizzleSchema`
 * in object form, it imports each SQLite `schema.ts` barrel, finds every
 * exported `*Dual` object, and asserts:
 *
 *   1. `Dual.sqlite` is exported under SOME key in the SQLite barrel (a value
 *      passing `is(_, SQLiteTable)`); AND
 *   2. `Dual.postgres` is exported under the SAME canonical key in the partner
 *      `schema.postgres.ts` barrel (a value passing `is(_, PgTable)`); AND
 *   3. both faces report the same `getTableName`.
 *
 * Discovery goes through {@link discoverSchemas} (the sanctioned API), not a
 * `schema.postgres.ts` glob: three client schema basenames are non-standard,
 * and only the declared lists know the true file set. The Postgres partner of a
 * declared `X.ts` is its sibling `X.postgres.ts` — the framework's twin-naming
 * convention for every dialect-paired schema file.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { is, getTableName } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { PgTable } from 'drizzle-orm/pg-core';
import { discoverSchemas } from '../discover-schemas.js';

/**
 * Marker every `defineDualTable` result satisfies: a plain object exposing both
 * dialect faces. `is()` deliberately skips it (it is neither a `SQLiteTable`
 * nor a `PgTable`), so the barrels must export the FACES, not the dual object.
 * @param value - Candidate export value.
 */
function isDualTable(value: unknown): value is { sqlite: SQLiteTable; postgres: PgTable } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sqlite' in value &&
    'postgres' in value &&
    is((value as { sqlite: unknown }).sqlite, SQLiteTable) &&
    is((value as { postgres: unknown }).postgres, PgTable)
  );
}

/**
 * Find the canonical export key under which `face` is re-exported in `barrel`,
 * matching by reference identity. Returns `undefined` when no key holds it.
 * @param barrel - Imported barrel module (export name → value).
 * @param face - The built table face to locate.
 */
function findFaceKey(barrel: Record<string, unknown>, face: unknown): string | undefined {
  for (const [key, value] of Object.entries(barrel)) {
    if (value === face) return key;
  }
  return undefined;
}

/**
 * Derive the Postgres partner path of a declared SQLite schema file.
 * @param sqlitePath - Absolute path to a declared `*.ts` SQLite schema barrel.
 * @returns Absolute path to the sibling `*.postgres.ts` Postgres barrel.
 */
function postgresPartnerPath(sqlitePath: string): string {
  return sqlitePath.replace(/\.ts$/, '.postgres.ts');
}

// workspace root = 4 levels up (matches the schema-parity loader):
// `__tests__/ → src/ → migrations/ → storage/ → framework/`.
const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');

describe('dual-table completeness across both chains', () => {
  it('every *Dual face is exported under one canonical key in BOTH barrels', async () => {
    const sqliteEntries = await discoverSchemas(workspaceRoot, undefined, 'sqlite');
    expect(sqliteEntries.length).toBeGreaterThan(0);

    let dualTablesChecked = 0;

    for (const entry of sqliteEntries) {
      const sqliteBarrel: Record<string, unknown> = await import(pathToFileURL(entry.schemaPath).href);

      const dualExports = Object.entries(sqliteBarrel).filter(([, value]) => isDualTable(value));
      if (dualExports.length === 0) continue;

      const partnerPath = postgresPartnerPath(entry.schemaPath);
      const postgresBarrel: Record<string, unknown> = await import(pathToFileURL(partnerPath).href);

      for (const [dualName, dualValue] of dualExports) {
        const dual = dualValue as { sqlite: SQLiteTable; postgres: PgTable };
        const where = `${entry.packageName} (${dualName} in ${path.basename(entry.schemaPath)})`;

        const sqliteKey = findFaceKey(sqliteBarrel, dual.sqlite);
        expect(
          sqliteKey,
          `${where}: the SQLite face of '${dualName}' is not exported under any key in ` +
            `${path.basename(entry.schemaPath)}. Add \`export const <name> = ${dualName}.sqlite;\`.`,
        ).toBeDefined();

        const postgresKey = findFaceKey(postgresBarrel, dual.postgres);
        expect(
          postgresKey,
          `${where}: the Postgres face of '${dualName}' is not exported under any key in ` +
            `${path.basename(partnerPath)}. Add \`export const <name> = ${dualName}.postgres;\`.`,
        ).toBeDefined();

        expect(
          postgresKey,
          `${where}: the Postgres face is exported under '${postgresKey}' but the SQLite face under ` +
            `'${sqliteKey}'. Both barrels must export the face under the SAME canonical key.`,
        ).toBe(sqliteKey);

        expect(
          getTableName(dual.postgres),
          `${where}: SQLite and Postgres faces report different SQL table names.`,
        ).toBe(getTableName(dual.sqlite));

        dualTablesChecked += 1;
      }
    }

    // Guard against the test silently passing because discovery found nothing
    // to verify (e.g. a path regression). At least the WO-1 table must be seen.
    expect(dualTablesChecked).toBeGreaterThan(0);
  }, 30_000);
});
