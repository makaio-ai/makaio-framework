/**
 * Drizzle schema for client binary installation state.
 *
 * Two tables:
 * - `client_binary_versions` — one row per installed version per client.
 * - `client_binary_state`   — one row per client for active-version pointer
 *   and feed-cache metadata.
 * @packageDocumentation
 */

import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Persistent store for individual installed version records.
 *
 * Each row represents one version of a managed client binary that has been
 * installed on disk. Rows are inserted on successful install and deleted on
 * explicit uninstall. The unique constraint on `(clientId, version)` prevents
 * duplicate entries for the same client+version pair.
 */
export const clientBinaryVersions = sqliteTable(
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
    installedAt: integer('installed_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this row was created. */
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_client_binary_versions_client_id').on(table.clientId),
    unique('uq_client_binary_versions_client_version').on(table.clientId, table.version),
  ],
);

/** Inferred insert type for the `client_binary_versions` table. */
export type InsertClientBinaryVersion = typeof clientBinaryVersions.$inferInsert;

/** Inferred select type for the `client_binary_versions` table. */
export type SelectClientBinaryVersion = typeof clientBinaryVersions.$inferSelect;

// ---------------------------------------------------------------------------

/**
 * Persistent store for per-client active-version pointer and feed-cache state.
 *
 * One row exists per managed client. The row is upserted on any state change.
 * `activeVersion` is `NULL` when no version is currently active (e.g. after
 * uninstalling the only installed version).
 */
export const clientBinaryState = sqliteTable('client_binary_state', {
  /** Stable client identifier (primary key). */
  clientId: text('client_id').primaryKey(),

  /**
   * Currently active version string, or `NULL` when no version is active.
   * A `NULL` here is semantically meaningful — it is not the same as "unknown".
   */
  activeVersion: text('active_version'),

  /** Latest version string from the upstream feed, or `NULL` when not yet fetched. */
  latestAvailableVersion: text('latest_available_version'),

  /**
   * Unix epoch timestamp in milliseconds when the feed was last successfully
   * checked, or `NULL` when the feed has never been checked.
   */
  latestVersionLastCheckedAt: integer('latest_version_last_checked_at'),

  /** Freshness/status of the latest-version source at the last refresh attempt. */
  latestVersionSourceStatus: text('latest_version_source_status', {
    enum: ['fresh', 'cached', 'error'],
  })
    .notNull()
    .default('error'),

  /** Unix epoch timestamp in milliseconds of the last mutation. */
  updatedAt: integer('updated_at').notNull(),
});

/** Inferred insert type for the `client_binary_state` table. */
export type InsertClientBinaryState = typeof clientBinaryState.$inferInsert;

/** Inferred select type for the `client_binary_state` table. */
export type SelectClientBinaryState = typeof clientBinaryState.$inferSelect;
