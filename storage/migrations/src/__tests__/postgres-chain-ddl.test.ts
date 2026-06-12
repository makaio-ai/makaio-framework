/**
 * DDL invariants of the landed Postgres migration chain.
 *
 * The framework requires fully unqualified Postgres DDL: the chain must land
 * in whichever schema leads the connection's `search_path` (consumers choose
 * their own schema; the storage conformance harness provisions one isolated
 * schema per suite). A single `"public".`-qualified identifier silently
 * breaks that model the first time the chain is applied outside `public`.
 *
 * `db:generate` enforces the invariant mechanically via
 * `normalize-postgres-migrations.ts`; this test pins it against any path that
 * bypasses the script (hand edits, tooling changes, drizzle-kit upgrades).
 */
import { describe, expect, it } from 'vitest';
import { readMigrations } from '../read-migrations.js';
import { getMigrationsFolder } from '../run-migrations.js';

describe('postgres migration chain DDL', () => {
  it('contains no schema-qualified identifiers (unqualified-DDL invariant)', () => {
    const migrations = readMigrations({
      migrationsDir: getMigrationsFolder('postgres'),
      expectedDialect: 'postgres',
    });
    expect(migrations.length).toBeGreaterThan(0);

    const offending = migrations.flatMap((migration) =>
      migration.sql
        .filter((statement) => statement.includes('"public".'))
        .map((statement) => `${migration.tag}: ${statement.slice(0, 120)}`),
    );

    expect(
      offending,
      'Schema-qualified DDL found in the Postgres chain. Run the db:generate pipeline ' +
        '(it ends with normalize-postgres-migrations.ts) or strip the "public". qualifiers — ' +
        "see the unqualified-DDL section in this package's README.",
    ).toEqual([]);
  });
});
