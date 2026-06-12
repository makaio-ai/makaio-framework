/**
 * Postgres twin schema for preferences storage.
 *
 * Mirrors the SQLite canonical schema exactly: same SQL column names,
 * same defaults, same unique index. No primary key — this table is
 * keyed solely by the composite unique index `preferences_pk`.
 * `value` stays plain `text` (hand-serialized JSON; jsonb would double-encode).
 */

import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';

/**
 * Postgres twin of the preferences table.
 *
 * Composite key: scope + surface + context + viewport + category
 * Value is stored as a JSON string (hand-serialized by the coordinator).
 */
export const preferences = pgTable(
  'preferences',
  {
    /** Ownership scope: 'global' or projectId */
    scope: text('scope').notNull(),
    /** Surface isolation: 'ui', 'app', or 'any' for unset */
    surface: text('surface').notNull().default('any'),
    /** Focus context for layout */
    context: text('context').notNull().default('any'),
    /** Viewport breakpoint */
    viewport: text('viewport').notNull().default('any'),
    /** Category of the preference */
    category: text('category').notNull(),
    /** JSON-serialized value (plain text; never jsonb) */
    value: text('value').notNull(),
    /** Last update timestamp (Unix ms) */
    updatedAt: epochMs('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('preferences_pk').on(table.scope, table.surface, table.context, table.viewport, table.category),
  ],
);
