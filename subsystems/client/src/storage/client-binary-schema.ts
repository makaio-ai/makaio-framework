/**
 * Drizzle schema for client binary installation state.
 *
 * Two tables:
 * - `client_binary_versions` — one row per installed version per client.
 * - `client_binary_state`   — one row per client for the active-version pointer.
 * @packageDocumentation
 */

import { unique } from 'drizzle-orm/sqlite-core';
import { unique as pgUnique } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Persistent store for individual installed version records.
 *
 * Each row represents one version of a managed client binary that has been
 * installed on disk. Rows are inserted on successful install and deleted on
 * explicit uninstall. The unique constraint on `(clientId, version)` prevents
 * duplicate entries for the same client+version pair.
 */
export const clientBinaryVersionsDual = defineDualTable(
  'client_binary_versions',
  (c) => ({
    /** Stable row identifier (UUID v4). */
    id: c.text('id').primaryKey(),

    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: c.text('client_id').notNull(),

    /** Resolved version string (semver or opaque tag). */
    version: c.text('version').notNull(),

    /** Absolute path to the directory containing the installed binary. */
    installPath: c.text('install_path').notNull(),

    /** Unix epoch timestamp in milliseconds when the binary was installed. */
    installedAt: c.epochMs('installed_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this row was created. */
    createdAt: c.epochMs('created_at').notNull(),
  }),
  {
    sqlite: (t) => [unique('uq_client_binary_versions_client_version').on(t.clientId, t.version)],
    postgres: (t) => [pgUnique('uq_client_binary_versions_client_version').on(t.clientId, t.version)],
  },
);

/** SQLite face of the `client_binary_versions` table (canonical schema). */
export const clientBinaryVersions = clientBinaryVersionsDual.sqlite;

/** Inferred insert type for the `client_binary_versions` table. */
export type InsertClientBinaryVersion = typeof clientBinaryVersions.$inferInsert;

/** Inferred select type for the `client_binary_versions` table. */
export type SelectClientBinaryVersion = typeof clientBinaryVersions.$inferSelect;

// ---------------------------------------------------------------------------

/**
 * Persistent store for the per-client active-version pointer.
 *
 * One row exists per managed client. The row is upserted on any state change.
 * `activeVersion` is `NULL` when no version is currently active (e.g. after
 * uninstalling the only installed version).
 */
export const clientBinaryStateDual = defineDualTable('client_binary_state', (c) => ({
  /** Stable client identifier (primary key). */
  clientId: c.text('client_id').primaryKey(),

  /**
   * Currently active version string, or `NULL` when no version is active.
   * A `NULL` here is semantically meaningful — it is not the same as "unknown".
   */
  activeVersion: c.text('active_version'),

  /** Unix epoch timestamp in milliseconds of the last mutation. */
  updatedAt: c.epochMs('updated_at').notNull(),
}));

/** SQLite face of the `client_binary_state` table (canonical schema). */
export const clientBinaryState = clientBinaryStateDual.sqlite;

/** Inferred insert type for the `client_binary_state` table. */
export type InsertClientBinaryState = typeof clientBinaryState.$inferInsert;

/** Inferred select type for the `client_binary_state` table. */
export type SelectClientBinaryState = typeof clientBinaryState.$inferSelect;
