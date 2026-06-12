/**
 * Tests for the raw-SQL call-site validator matcher.
 *
 * The matcher must catch the call shapes a naive line-based grep misses:
 * generic raw driver calls (`db.all<T>(…)`) and zero-argument builder
 * terminals on their own line after a multi-line chain — while not flagging
 * stdlib zero-argument calls such as `new Map(…).values()`.
 */
import { describe, expect, it } from 'vitest';
import { findRawSqlViolations, isInScope, RAW_SQL_SUPPRESSION_TOKEN } from './raw-sql-validator.js';

describe('findRawSqlViolations — raw driver calls', () => {
  it('flags plain raw driver calls on db', () => {
    const violations = findRawSqlViolations(`await db.run(sql.raw('BEGIN'));\n`);
    expect(violations).toEqual([{ line: 1, kind: 'raw-driver-call', snippet: "await db.run(sql.raw('BEGIN'));" }]);
  });

  it('flags generic raw driver calls (db.all<T>(…) and db.values<[T]>(…))', () => {
    const source = [
      'const tables = await this.db.all<{ name: string }>(',
      '  sql`SELECT name FROM sqlite_master`,',
      ');',
      'const appliedRows = await db.values<[string]>(sql`SELECT hash FROM t`);',
    ].join('\n');

    const violations = findRawSqlViolations(source);
    expect(violations.map((v) => ({ line: v.line, kind: v.kind }))).toEqual([
      { line: 1, kind: 'raw-driver-call' },
      { line: 4, kind: 'raw-driver-call' },
    ]);
  });

  it('does not flag mentions inside comments or string literals', () => {
    const source = [
      '// migrate every db.run(…) call onto the executor',
      '/** Uses db.values() to read the ledger. */',
      "console.warn('never call db.all(query) directly');",
    ].join('\n');

    expect(findRawSqlViolations(source)).toEqual([]);
  });
});

describe('findRawSqlViolations — builder terminals', () => {
  it('flags a terminal on its own line after a multi-line builder chain', () => {
    const source = [
      'await db',
      '  .insert(preferences)',
      '  .values({ category, value })',
      '  .onConflictDoUpdate({ target: [preferences.scope], set: { value } })',
      '  .run();',
    ].join('\n');

    const violations = findRawSqlViolations(source);
    expect(violations).toEqual([{ line: 5, kind: 'builder-terminal', snippet: '.run();' }]);
  });

  it('flags single-line .all() and .get() terminals on a db-rooted chain', () => {
    const source = [
      'const rows = await db.select().from(preferences).all();',
      'const row = await db.select().from(preferences).where(eq(a, b)).get();',
    ].join('\n');

    const violations = findRawSqlViolations(source);
    expect(violations.map((v) => ({ line: v.line, kind: v.kind }))).toEqual([
      { line: 1, kind: 'builder-terminal' },
      { line: 2, kind: 'builder-terminal' },
    ]);
  });

  it('does not flag stdlib zero-argument calls such as new Map(…).values()', () => {
    const source = 'const deduped = Array.from(new Map(candidates.map((c) => [key(c), c])).values());\n';
    expect(findRawSqlViolations(source)).toEqual([]);
  });

  it('does not flag builder .values({...}) calls that carry arguments', () => {
    const source = 'await db.insert(preferences).values({ category });\n';
    expect(findRawSqlViolations(source)).toEqual([]);
  });

  it('does not let a db-rooted chain in a previous statement implicate a stdlib call', () => {
    const source = [
      'const rows = await db.select().from(preferences);',
      'const ids = Array.from(new Map(rows.map((r) => [r.id, r])).values());',
    ].join('\n');

    expect(findRawSqlViolations(source)).toEqual([]);
  });
});

describe('findRawSqlViolations — suppression', () => {
  it('skips matches with the suppression token on the same line or the line above', () => {
    const source = [
      `// ${RAW_SQL_SUPPRESSION_TOKEN}: concrete driver handle, reviewed`,
      "await db.run(sql.raw('PRAGMA foreign_keys = ON'));",
      `await db.run(sql.raw('BEGIN')); // ${RAW_SQL_SUPPRESSION_TOKEN}: reviewed`,
      "await db.run(sql.raw('COMMIT'));",
    ].join('\n');

    const violations = findRawSqlViolations(source);
    expect(violations).toEqual([{ line: 4, kind: 'raw-driver-call', snippet: "await db.run(sql.raw('COMMIT'));" }]);
  });
});

describe('isInScope', () => {
  it('scans production src files and skips tests, non-src files, and the allowlist', () => {
    expect(isInScope('services/core/src/session/storage/ancestor-query.ts')).toBe(true);
    expect(isInScope('services/core/src/session/storage/__tests__/search.test.ts')).toBe(false);
    expect(isInScope('services/core/src/session/storage/inline.test.ts')).toBe(false);
    expect(isInScope('scripts/lib/raw-sql-validator.ts')).toBe(false);
    expect(isInScope('storage/drizzle/src/engine/sqlite/client.ts')).toBe(false);
    expect(isInScope('storage/drizzle/src/client.ts')).toBe(true);
    expect(isInScope('storage/drizzle/src/raw-sql.ts')).toBe(false);
  });
});
