/**
 * Tests for the SQLite and Postgres column bundles.
 *
 * All assertions operate on real drizzle table configurations via
 * `getTableConfig` — no mocks. This test suite encodes the "bundle adoption
 * produces zero migration diff" guarantee for the SQLite side, and the correct
 * pg-core type image for the Postgres side.
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { sqliteTable, integer, real, text, getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { pgTable, getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core';
import { epochMs, bool, jsonCol, autoPk, float8 } from '../columns/sqlite';
import {
  epochMs as epochMsPg,
  bool as boolPg,
  jsonCol as jsonColPg,
  autoPk as autoPkPg,
  float8 as float8Pg,
} from '../columns/postgres';

// ---------------------------------------------------------------------------
// a. SQLite-equivalence — bundle adoption produces zero migration diff
// ---------------------------------------------------------------------------

describe('SQLite column bundles: structural equivalence to inline builders', () => {
  const bundleTable = sqliteTable('bundle_eq', {
    id: autoPk('id'),
    ts: epochMs('ts').notNull(),
    flag: bool('flag').notNull().default(false),
    payload: jsonCol<{ a: number }>('payload'),
    cost: float8('cost'),
  });

  const inlineTable = sqliteTable('inline_eq', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    flag: integer('flag', { mode: 'boolean' }).notNull().default(false),
    payload: text('payload', { mode: 'json' }).$type<{ a: number }>(),
    cost: real('cost'),
  });

  it('id: columnType, getSQLType, primary, autoIncrement are identical', () => {
    const bundleCfg = getSqliteTableConfig(bundleTable);
    const inlineCfg = getSqliteTableConfig(inlineTable);
    const bid = bundleCfg.columns.find((c) => c.name === 'id')!;
    const iid = inlineCfg.columns.find((c) => c.name === 'id')!;
    expect(bid.columnType).toBe(iid.columnType);
    expect(bid.getSQLType()).toBe(iid.getSQLType());
    expect(bid.primary).toBe(iid.primary);
    expect((bid as { autoIncrement?: boolean }).autoIncrement).toBe((iid as { autoIncrement?: boolean }).autoIncrement);
  });

  it('ts: columnType, getSQLType, notNull are identical', () => {
    const bundleCfg = getSqliteTableConfig(bundleTable);
    const inlineCfg = getSqliteTableConfig(inlineTable);
    const bts = bundleCfg.columns.find((c) => c.name === 'ts')!;
    const its = inlineCfg.columns.find((c) => c.name === 'ts')!;
    expect(bts.columnType).toBe(its.columnType);
    expect(bts.getSQLType()).toBe(its.getSQLType());
    expect(bts.notNull).toBe(its.notNull);
  });

  it('flag: columnType, getSQLType, notNull, hasDefault, default are identical', () => {
    const bundleCfg = getSqliteTableConfig(bundleTable);
    const inlineCfg = getSqliteTableConfig(inlineTable);
    const bf = bundleCfg.columns.find((c) => c.name === 'flag')!;
    const inf = inlineCfg.columns.find((c) => c.name === 'flag')!;
    expect(bf.columnType).toBe(inf.columnType);
    expect(bf.getSQLType()).toBe(inf.getSQLType());
    expect(bf.notNull).toBe(inf.notNull);
    expect(bf.hasDefault).toBe(inf.hasDefault);
    expect(bf.default).toBe(inf.default);
  });

  it('payload: columnType, getSQLType are identical', () => {
    const bundleCfg = getSqliteTableConfig(bundleTable);
    const inlineCfg = getSqliteTableConfig(inlineTable);
    const bp = bundleCfg.columns.find((c) => c.name === 'payload')!;
    const ip = inlineCfg.columns.find((c) => c.name === 'payload')!;
    expect(bp.columnType).toBe(ip.columnType);
    expect(bp.getSQLType()).toBe(ip.getSQLType());
  });

  it('cost: columnType, getSQLType are identical', () => {
    const bundleCfg = getSqliteTableConfig(bundleTable);
    const inlineCfg = getSqliteTableConfig(inlineTable);
    const bc = bundleCfg.columns.find((c) => c.name === 'cost')!;
    const ic = inlineCfg.columns.find((c) => c.name === 'cost')!;
    expect(bc.columnType).toBe(ic.columnType);
    expect(bc.getSQLType()).toBe(ic.getSQLType());
  });
});

// ---------------------------------------------------------------------------
// b. Postgres type image — pg-core columnType and getSQLType per column
// ---------------------------------------------------------------------------

describe('Postgres column bundles: type image', () => {
  const pgBundleTable = pgTable('pg_bundle', {
    id: autoPkPg('id'),
    ts: epochMsPg('ts').notNull(),
    flag: boolPg('flag').notNull(),
    payload: jsonColPg<{ a: number }>('payload'),
    cost: float8Pg('cost'),
  });

  it('epochMs maps to PgBigInt53 / bigint', () => {
    const cfg = getPgTableConfig(pgBundleTable);
    const col = cfg.columns.find((c) => c.name === 'ts')!;
    expect(col.columnType).toBe('PgBigInt53');
    expect(col.getSQLType()).toBe('bigint');
    expect(col.notNull).toBe(true);
  });

  it('bool maps to PgBoolean / boolean', () => {
    const cfg = getPgTableConfig(pgBundleTable);
    const col = cfg.columns.find((c) => c.name === 'flag')!;
    expect(col.columnType).toBe('PgBoolean');
    expect(col.getSQLType()).toBe('boolean');
    expect(col.notNull).toBe(true);
  });

  it('jsonCol maps to PgJsonb / jsonb', () => {
    const cfg = getPgTableConfig(pgBundleTable);
    const col = cfg.columns.find((c) => c.name === 'payload')!;
    expect(col.columnType).toBe('PgJsonb');
    expect(col.getSQLType()).toBe('jsonb');
  });

  it('float8 maps to PgDoublePrecision / double precision', () => {
    const cfg = getPgTableConfig(pgBundleTable);
    const col = cfg.columns.find((c) => c.name === 'cost')!;
    expect(col.columnType).toBe('PgDoublePrecision');
    expect(col.getSQLType()).toBe('double precision');
  });

  it('autoPk maps to PgBigInt53 with primary=true and generatedAlwaysAsIdentity', () => {
    const cfg = getPgTableConfig(pgBundleTable);
    const col = cfg.columns.find((c) => c.name === 'id')!;
    expect(col.columnType).toBe('PgBigInt53');
    expect(col.primary).toBe(true);
    expect((col as { generatedIdentity?: { type: string } }).generatedIdentity?.type).toBe('always');
  });
});

// ---------------------------------------------------------------------------
// c. Chaining — .notNull(), .default(v), .default(sql`'{}'`) surface in config
// ---------------------------------------------------------------------------

describe('SQLite column bundles: chaining produces correct metadata', () => {
  it('epochMs().notNull() sets notNull in config', () => {
    const t = sqliteTable('chain_test', { ts: epochMs('ts').notNull() });
    const cfg = getSqliteTableConfig(t);
    const col = cfg.columns.find((c) => c.name === 'ts')!;
    expect(col.notNull).toBe(true);
  });

  it('bool().default(false) sets hasDefault=true in config', () => {
    const t = sqliteTable('chain_test2', { flag: bool('flag').default(false) });
    const cfg = getSqliteTableConfig(t);
    const col = cfg.columns.find((c) => c.name === 'flag')!;
    expect(col.hasDefault).toBe(true);
  });

  it("jsonCol().default(sql`'{}'`) sets hasDefault=true in config", () => {
    const t = sqliteTable('chain_test3', { data: jsonCol<object>('data').default(sql`'{}'`) });
    const cfg = getSqliteTableConfig(t);
    const col = cfg.columns.find((c) => c.name === 'data')!;
    expect(col.hasDefault).toBe(true);
  });

  it('float8().notNull().default(0) sets both notNull and hasDefault in config', () => {
    const t = sqliteTable('chain_test4', { cost: float8('cost').notNull().default(0) });
    const cfg = getSqliteTableConfig(t);
    const col = cfg.columns.find((c) => c.name === 'cost')!;
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });
});
