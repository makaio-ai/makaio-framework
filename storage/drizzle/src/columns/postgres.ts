/**
 * Postgres column bundle for the storage dialect design.
 *
 * These helpers encode the fixed SQLite→Postgres column mapping table so that
 * twin schema files stay mechanically in sync with their canonical counterparts:
 *
 * | Bundle               | SQL type (Postgres)                                      |
 * |----------------------|----------------------------------------------------------|
 * | `epochMs`            | `bigint` ('number' mode, int53-safe)                     |
 * | `bool`               | `boolean`                                                |
 * | `jsonCol`            | `jsonb`                                                  |
 * | `autoPk`             | `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`        |
 * | `float8`             | `double precision`                                       |
 *
 * **Accepted divergences (jsonCol → jsonb):** jsonb silently rejects `\u0000`
 * escapes, normalizes key order, and drops duplicate keys. Plain `text` columns
 * holding hand-stringified JSON stay `text` on both dialects — this bundle is
 * for structured JSON that drizzle serializes and deserializes.
 *
 * **Partial-index predicate rewrites:** boolean partial indexes use `= 1` on
 * SQLite and `= true` on Postgres. Postgres twin schema files must rewrite such
 * predicates to `= true` in their `.where()` clauses — drizzle-kit emits DDL
 * mechanically from the twin source, and `= 1` against a native boolean column
 * is a type error on Postgres.
 *
 * **`autoPk` monotonicity caveat:** identity values are strictly increasing per
 * single writer. Cursor pagination over this key assumes a single writer
 * process.
 *
 * **`epochMs` precision:** stored as `bigint` in JavaScript `'number'` mode
 * (int53-safe). No SQL date arithmetic is performed in the framework; the
 * column holds raw millisecond offsets.
 *
 * **`float8` vs `real`:** Postgres `real` is 4-byte and would silently narrow
 * values that are 8-byte in SQLite. `double precision` preserves the range.
 * @packageDocumentation
 */

import { bigint, boolean, doublePrecision, jsonb } from 'drizzle-orm/pg-core';

/**
 * Unix-epoch-milliseconds timestamp column.
 * SQLite: `integer`. Postgres twin: `bigint` in `'number'` mode (int53-safe;
 * no SQL date arithmetic exists in the framework).
 * @param name - SQL column name.
 * @returns Chainable Postgres `bigint` ('number' mode) column builder.
 */
export const epochMs = (name: string) => bigint(name, { mode: 'number' });

/**
 * Boolean flag column.
 * SQLite: `integer` in `'boolean'` mode. Postgres twin: native `boolean`.
 * Partial-index predicates over these columns are `= 1` on SQLite and
 * `= true` on Postgres.
 * @param name - SQL column name.
 * @returns Chainable Postgres `boolean` column builder.
 */
export const bool = (name: string) => boolean(name);

/**
 * Structured JSON column (drizzle serializes/deserializes).
 * SQLite: `text` in `'json'` mode. Postgres twin: `jsonb` (accepted divergence:
 * jsonb rejects `\u0000` escapes, normalizes key order, drops duplicate keys).
 * NOT for hand-stringified JSON held in plain `text` columns — those stay `text`.
 * @param name - SQL column name.
 * @typeParam T - Deserialized value type pinned via `$type`.
 * @returns Chainable Postgres `jsonb` column builder typed as `T`.
 */
export const jsonCol = <T>(name: string) => jsonb(name).$type<T>();

/**
 * Auto-generated integer primary key.
 * SQLite: `integer ... PRIMARY KEY AUTOINCREMENT`. Postgres twin:
 * `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (`'number'` mode).
 * Monotonicity note: identity values are strictly increasing per single
 * writer; cursor pagination over this key assumes a single writer process.
 * @param name - SQL column name.
 * @returns Chainable Postgres identity `bigint` primary-key column builder.
 */
export const autoPk = (name: string) => bigint(name, { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey();

/**
 * Eight-byte floating-point column.
 * SQLite: `real` (always 8-byte). Postgres twin: `double precision` —
 * Postgres `real` is 4-byte and would silently narrow.
 * @param name - SQL column name.
 * @returns Chainable Postgres `double precision` column builder.
 */
export const float8 = (name: string) => doublePrecision(name);
