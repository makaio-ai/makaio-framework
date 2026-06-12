/**
 * Drizzle schema for client profiles.
 *
 * One table:
 * - `client_profiles` — one row per named configuration profile per client.
 * @packageDocumentation
 */

import { sql } from 'drizzle-orm';
import { uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Persistent store for named client configuration profiles.
 *
 * Each row represents a named configuration profile for a managed client. The
 * unique constraint on `(clientId, name)` prevents duplicate profile names
 * within the same client. At most one profile per client may have
 * `isDefault = true`; storage enforces this with a partial unique index so
 * concurrent promotions cannot persist multiple defaults.
 */
export const clientProfilesDual = defineDualTable(
  'client_profiles',
  (c) => ({
    /** Stable row identifier (UUID v4). */
    id: c.text('id').primaryKey(),

    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: c.text('client_id').notNull(),

    /** Human-readable profile name (unique per client). */
    name: c.text('name').notNull(),

    /** Optional description of the profile's purpose. */
    description: c.text('description'),

    /** Absolute path to the directory used as the configuration home for this profile. */
    configDir: c.text('config_dir').notNull(),

    /**
     * Whether this profile is the default for its client.
     *
     * At most one profile per client should have this set to `true` at any
     * given time. A partial unique index and the storage `setDefault`
     * operation enforce that invariant.
     */
    isDefault: c.bool('is_default').notNull().default(false),

    /** Unix epoch timestamp in milliseconds when this row was created. */
    createdAt: c.epochMs('created_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this row was last updated. */
    updatedAt: c.epochMs('updated_at').notNull(),
  }),
  {
    sqlite: (t) => [
      uniqueIndex('uq_client_profiles_client_name').on(t.clientId, t.name),
      uniqueIndex('uq_client_profiles_default').on(t.clientId).where(sql`${t.isDefault} = 1`),
    ],
    postgres: (t) => [
      pgUniqueIndex('uq_client_profiles_client_name').on(t.clientId, t.name),
      pgUniqueIndex('uq_client_profiles_default').on(t.clientId).where(sql`${t.isDefault} = true`),
    ],
  },
);

/** SQLite face of the `client_profiles` table (canonical schema). */
export const clientProfiles = clientProfilesDual.sqlite;

/** Inferred insert type for the `client_profiles` table. */
export type InsertClientProfile = typeof clientProfiles.$inferInsert;

/** Inferred select type for the `client_profiles` table. */
export type SelectClientProfile = typeof clientProfiles.$inferSelect;
