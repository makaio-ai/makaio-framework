/**
 * Drizzle schema for preferences storage.
 *
 * Single table storing key-value preferences with composite key.
 */

import { uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Preferences table for persistent key-value storage.
 *
 * Composite key: scope + surface + context + viewport + category
 * Value is stored as JSON string.
 */
export const preferencesDual = defineDualTable(
  'preferences',
  (c) => ({
    /** Ownership scope: 'global' or projectId */
    scope: c.text('scope').notNull(),
    /** Surface isolation: 'ui', 'app', or 'any' for unset */
    surface: c.text('surface').notNull().default('any'),
    /** Focus context for layout */
    context: c.text('context').notNull().default('any'),
    /** Viewport breakpoint */
    viewport: c.text('viewport').notNull().default('any'),
    /** Category of the preference */
    category: c.text('category').notNull(),
    /** JSON-serialized value */
    value: c.text('value').notNull(),
    /** Last update timestamp (Unix ms) */
    updatedAt: c.epochMs('updated_at').notNull(),
  }),
  {
    sqlite: (t) => [uniqueIndex('preferences_pk').on(t.scope, t.surface, t.context, t.viewport, t.category)],
    postgres: (t) => [pgUniqueIndex('preferences_pk').on(t.scope, t.surface, t.context, t.viewport, t.category)],
  },
);

/** SQLite face of the `preferences` table (canonical schema). */
export const preferences = preferencesDual.sqlite;

export type PreferenceRow = typeof preferences.$inferSelect;
export type NewPreferenceRow = typeof preferences.$inferInsert;
