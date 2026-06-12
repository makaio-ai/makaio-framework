/**
 * Canonical fixture table used by conformance suites that need a simple
 * key-value store to exercise isolation, sibling clients, and DDL execution.
 *
 * The fixture schema follows the same dialect-twin pattern as production schemas:
 * a canonical SQLite table paired with a congruent Postgres twin, combined via
 * `defineDialectSchema` so `resolveSchema` selects the correct runtime objects.
 * @packageDocumentation
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { jsonCol as sqliteJsonCol } from '@makaio/storage-drizzle/columns/sqlite';
import { jsonCol as pgJsonCol } from '@makaio/storage-drizzle/columns/postgres';
import { defineDialectSchema, type DialectSchema, StorageDialect } from '@makaio/storage-drizzle';

/**
 * Canonical SQLite fixture table: conformance_kv(id text pk, label text, payload jsonCol).
 */
export const conformanceKvSqlite = sqliteTable('conformance_kv', {
  id: text('id').primaryKey(),
  label: text('label'),
  payload: sqliteJsonCol<Record<string, unknown>>('payload'),
});

/**
 * Congruent Postgres twin of the fixture table.
 */
const conformanceKvPg = pgTable('conformance_kv', {
  id: pgText('id').primaryKey(),
  label: pgText('label'),
  payload: pgJsonCol<Record<string, unknown>>('payload'),
});

/**
 * DialectSchema over the fixture table. Key: 'kv'.
 *
 * Pass to `resolveSchema(db, fixtureKv)` to obtain the dialect-correct table
 * objects at runtime.
 */
export const fixtureKv: DialectSchema<{ kv: typeof conformanceKvSqlite }> = defineDialectSchema(
  { kv: conformanceKvSqlite },
  { kv: conformanceKvPg },
);

/**
 * Hand-written CREATE TABLE DDL for the fixture table per dialect.
 *
 * Uses unqualified table names so the DDL lands in the active schema on both
 * SQLite (single schema) and Postgres (search_path-pinned schema).
 * SQLite: payload TEXT. Postgres: payload jsonb.
 * @param dialect - Target dialect.
 * @returns CREATE TABLE statement for the fixture table.
 */
export function fixtureKvDdl(dialect: StorageDialect): string {
  if (dialect === 'postgres') {
    return `CREATE TABLE IF NOT EXISTS "conformance_kv" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text,
  "payload" jsonb
)`;
  }

  return `CREATE TABLE IF NOT EXISTS "conformance_kv" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text,
  "payload" TEXT
)`;
}
