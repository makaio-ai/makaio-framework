/**
 * Tests for {@link defineDialectSchema} and {@link resolveSchema}.
 *
 * Runtime assertions use real drizzle table objects and a real in-memory libsql
 * database handle — no mocks. Compile-time assertions use `@ts-expect-error` to
 * confirm that select-row drift and missing twins are caught by the type system.
 */
import { describe, it, expect } from 'vitest';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { pgTable, PgTable } from 'drizzle-orm/pg-core';
import { brandDatabase, getRawSqlExecutor } from '../raw-sql';
import { epochMs, bool } from '../columns/sqlite';
import { epochMs as epochMsPg, bool as boolPg } from '../columns/postgres';
import { defineDialectSchema, resolveSchema } from '../dialect';
import { getDatabaseDialect, type MakaioDatabase } from '../types';

// ---------------------------------------------------------------------------
// Shared fixture tables — minimal, congruent pair using the column bundles
// ---------------------------------------------------------------------------

const things = sqliteTable('things', {
  ts: epochMs('ts').notNull(),
  active: bool('active').notNull().default(false),
});

const thingsPg = pgTable('things', {
  ts: epochMsPg('ts').notNull(),
  active: boolPg('active').notNull().default(false),
});

const dialectSchema = defineDialectSchema({ things }, { things: thingsPg });

// ---------------------------------------------------------------------------
// a. Runtime: resolveSchema returns sqlite branch for unbranded handles,
//    postgres branch for pg-branded handles
// ---------------------------------------------------------------------------

describe('resolveSchema', () => {
  it('returns schema.sqlite for an unbranded in-memory libsql handle', async () => {
    const rawDb = drizzle({ connection: { url: ':memory:' } });
    // No branding — getDatabaseDialect defaults to 'sqlite'
    const resolved = resolveSchema(rawDb, dialectSchema);
    expect(resolved).toBe(dialectSchema.sqlite);
  });

  it('returns schema.postgres for a pg-branded libsql handle', async () => {
    const rawDb = drizzle({ connection: { url: ':memory:' } });
    const db = brandDatabase(rawDb, 'postgres', { ...getRawSqlExecutor(rawDb), dialect: 'postgres' as const });
    const resolved = resolveSchema(db, dialectSchema);
    expect(resolved).toBe(dialectSchema.postgres);
  });
});

// ---------------------------------------------------------------------------
// b. Compile-time pins — drift and missing twins are compile errors
// ---------------------------------------------------------------------------

describe('defineDialectSchema: compile-time safety (type-level assertions)', () => {
  it('accepts a congruent twin without error', () => {
    // Already proven by module-level defineDialectSchema call above compiling.
    expect(dialectSchema.sqlite.things).toBe(things);
  });

  it('rejects a twin with select-row drift (type guard via @ts-expect-error)', () => {
    // A pg twin with a nullable column where the SQLite side is notNull creates
    // a $inferSelect row mismatch — the compiler should reject this.
    const driftedTwin = pgTable('things', {
      ts: epochMsPg('ts'), // nullable — drifted from notNull on the sqlite side
      active: boolPg('active').notNull().default(false),
    });
    // @ts-expect-error: select-row drift — ts is nullable on pg but notNull on sqlite
    defineDialectSchema({ things }, { things: driftedTwin });
  });

  it('rejects a missing twin key (type guard via @ts-expect-error)', () => {
    // Passing an empty object for the postgres argument is rejected because
    // `things` key is required.
    // @ts-expect-error: missing 'things' key in the postgres twin record
    defineDialectSchema({ things }, {});
  });

  it('resolved record is SQLite-typed ($inferSelect accepts the sqlite row shape)', () => {
    // Type assertion: the resolved record is typed as TSqlite, which means
    // accessing $inferSelect gives us the canonical sqlite row shape.
    const resolved = resolveSchema(drizzle({ connection: { url: ':memory:' } }), dialectSchema);
    // The following assignment compiles only when resolved.things.$inferSelect
    // matches { ts: number; active: boolean }
    type ResolvedRow = typeof resolved.things.$inferSelect;
    const _typeCheck: ResolvedRow = { ts: 1, active: false };
    expect(_typeCheck.ts).toBe(1);
    // Runtime: an unbranded handle resolves to the canonical sqlite record.
    expect(resolved.things).toBe(things);
  });
});

// ---------------------------------------------------------------------------
// c. defineDialectSchema: postgres property holds the real pgTable instances
// ---------------------------------------------------------------------------

describe('defineDialectSchema: postgres property holds real pgTable objects', () => {
  it('dialectSchema.postgres.things is the real pgTable (is(v, PgTable) === true)', () => {
    // The honesty-model cast in defineDialectSchema presents postgres as TSqlite
    // at the type level, but the runtime object is the real pgTable twin.
    // Cast through unknown to inspect the runtime identity.
    const pgRuntimeValue = dialectSchema.postgres.things as unknown;
    expect(is(pgRuntimeValue, PgTable)).toBe(true);
  });

  it('dialectSchema.sqlite.things is the real sqliteTable (reference identity)', () => {
    expect(dialectSchema.sqlite.things).toBe(things);
  });
});

// ---------------------------------------------------------------------------
// Bonus: second independent defineDialectSchema call confirms the pattern
// generalises beyond the module-level fixture.
// ---------------------------------------------------------------------------

describe('defineDialectSchema: independent second schema definition', () => {
  it('compiles and resolves correctly for a second epochMs-keyed schema', () => {
    // A second independent congruent pair — confirms defineDialectSchema is not
    // coupled to the module-level fixture and that typescript infers the right
    // generic parameters independently for each call.
    const records = sqliteTable('records', { id: epochMs('id').notNull() });
    const recordsPg = pgTable('records', { id: epochMsPg('id').notNull() });
    const s = defineDialectSchema({ records }, { records: recordsPg });
    expect(s.sqlite.records).toBe(records);
    const pgRuntime = s.postgres.records as unknown;
    expect(is(pgRuntime, PgTable)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// d. Schema-generic handles — variance pin
// ---------------------------------------------------------------------------

describe('schema-generic handles', () => {
  it('accepts a handle typed with a non-default schema generic', () => {
    // Compile-time pin: `MakaioDatabase<Record<string, unknown>>` must be
    // accepted by both getDatabaseDialect and resolveSchema. A handle with a
    // non-default schema generic is NOT assignable to the default
    // `MakaioDatabase` (`Record<string, unknown>` fails against
    // `Record<string, never>` via `_.fullSchema`), so the two calls below
    // would fail to type-check if the parameter types were still the
    // narrower `MakaioDatabase`.
    const db: MakaioDatabase<Record<string, unknown>> = drizzle({ connection: { url: ':memory:' } });
    expect(getDatabaseDialect(db)).toBe('sqlite');
    expect(resolveSchema(db, dialectSchema)).toBe(dialectSchema.sqlite);
  });
});
