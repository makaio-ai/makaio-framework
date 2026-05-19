/**
 * Drizzle schema for client profiles.
 *
 * One table:
 * - `client_profiles` — one row per named configuration profile per client.
 * @packageDocumentation
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Persistent store for named client configuration profiles.
 *
 * Each row represents a named configuration profile for a managed client. The
 * unique constraint on `(clientId, name)` prevents duplicate profile names
 * within the same client. At most one profile per client may have
 * `isDefault = true`; storage enforces this with a partial unique index so
 * concurrent promotions cannot persist multiple defaults.
 */
export const clientProfiles = sqliteTable(
  'client_profiles',
  {
    /** Stable row identifier (UUID v4). */
    id: text('id').primaryKey(),

    /** Stable client identifier (e.g. `'claude-code'`). */
    clientId: text('client_id').notNull(),

    /** Human-readable profile name (unique per client). */
    name: text('name').notNull(),

    /** Optional description of the profile's purpose. */
    description: text('description'),

    /** Absolute path to the directory used as the configuration home for this profile. */
    configDir: text('config_dir').notNull(),

    /**
     * Whether this profile is the default for its client.
     *
     * At most one profile per client should have this set to `true` at any
     * given time. A partial unique index and the storage `setDefault`
     * operation enforce that invariant.
     */
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),

    /** Unix epoch timestamp in milliseconds when this row was created. */
    createdAt: integer('created_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this row was last updated. */
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_client_profiles_client_name').on(table.clientId, table.name),
    uniqueIndex('uq_client_profiles_default').on(table.clientId).where(sql`${table.isDefault} = 1`),
    index('idx_client_profiles_client_id').on(table.clientId),
  ],
);

/** Inferred insert type for the `client_profiles` table. */
export type InsertClientProfile = typeof clientProfiles.$inferInsert;

/** Inferred select type for the `client_profiles` table. */
export type SelectClientProfile = typeof clientProfiles.$inferSelect;
