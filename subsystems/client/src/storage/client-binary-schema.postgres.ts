/**
 * Postgres twin for the client binary installation state tables.
 *
 * Two tables:
 * - `client_binary_versions` — one row per installed version per client.
 * - `client_binary_state`   — one row per client for the active-version pointer.
 *
 * Timestamp columns use `bigint` in `'number'` mode (int53-safe epoch
 * milliseconds). The unique constraint on `client_binary_versions` mirrors the
 * canonical SQLite table-level `unique()` constraint exactly — it is NOT a
 * `uniqueIndex` so that parity-net comparison across constraint buckets is
 * consistent.
 * @packageDocumentation
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';

/**
 * Persistent store for individual installed version records.
 *
 * Each row represents one version of a managed client binary that has been
 * installed on disk. Rows are inserted on successful install and deleted on
 * explicit uninstall. The unique constraint on `(clientId, version)` prevents
 * duplicate entries for the same client+version pair.
 */
export const clientBinaryVersions = pgTable(
  'client_binary_versions',
  {
    /** Stable row identifier (UUID v4). */
    id: text('id').primaryKey(),

    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: text('client_id').notNull(),

    /** Resolved version string (semver or opaque tag). */
    version: text('version').notNull(),

    /** Absolute path to the directory containing the installed binary. */
    installPath: text('install_path').notNull(),

    /** Unix epoch timestamp in milliseconds when the binary was installed. */
    installedAt: epochMs('installed_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this row was created. */
    createdAt: epochMs('created_at').notNull(),
  },
  (table) => [unique('uq_client_binary_versions_client_version').on(table.clientId, table.version)],
);

// ---------------------------------------------------------------------------

/**
 * Persistent store for the per-client active-version pointer.
 *
 * One row exists per managed client. The row is upserted on any state change.
 * `activeVersion` is `NULL` when no version is currently active (e.g. after
 * uninstalling the only installed version).
 */
export const clientBinaryState = pgTable('client_binary_state', {
  /** Stable client identifier (primary key). */
  clientId: text('client_id').primaryKey(),

  /**
   * Currently active version string, or `NULL` when no version is active.
   * A `NULL` here is semantically meaningful — it is not the same as "unknown".
   */
  activeVersion: text('active_version'),

  /** Unix epoch timestamp in milliseconds of the last mutation. */
  updatedAt: epochMs('updated_at').notNull(),
});
