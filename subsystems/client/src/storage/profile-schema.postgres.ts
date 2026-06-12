/**
 * Postgres twin for the `client_profiles` table.
 *
 * Column semantics are identical to the canonical SQLite schema. The boolean
 * `is_default` column uses a native Postgres `boolean` type. The partial unique
 * index predicate is rewritten from `= 1` (SQLite integer-boolean) to `= true`
 * (Postgres native boolean) — `= 1` is a DDL type error on Postgres.
 * The parity net asserts partial-index presence, not predicate text; the
 * literal divergence is intentional and by design.
 * @packageDocumentation
 */

import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { bool, epochMs } from '@makaio/storage-drizzle/columns/postgres';

/**
 * Persistent store for named client configuration profiles.
 *
 * Each row represents a named configuration profile for a managed client. The
 * unique constraint on `(clientId, name)` prevents duplicate profile names
 * within the same client. At most one profile per client may have
 * `isDefault = true`; storage enforces this with a partial unique index so
 * concurrent promotions cannot persist multiple defaults.
 */
export const clientProfiles = pgTable(
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
    isDefault: bool('is_default').notNull().default(false),

    /** Unix epoch timestamp in milliseconds when this row was created. */
    createdAt: epochMs('created_at').notNull(),

    /** Unix epoch timestamp in milliseconds when this row was last updated. */
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_client_profiles_client_name').on(table.clientId, table.name),
    uniqueIndex('uq_client_profiles_default').on(table.clientId).where(sql`${table.isDefault} = true`),
  ],
);
