/**
 * Drizzle schema for preferences storage.
 *
 * Single table storing key-value preferences with composite key.
 */

import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Preferences table for persistent key-value storage.
 *
 * Composite key: scope + surface + context + viewport + category
 * Value is stored as JSON string.
 */
export const preferences = sqliteTable(
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
    /** JSON-serialized value */
    value: text('value').notNull(),
    /** Last update timestamp (Unix ms) */
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('preferences_pk').on(table.scope, table.surface, table.context, table.viewport, table.category),
  ],
);

export type PreferenceRow = typeof preferences.$inferSelect;
export type NewPreferenceRow = typeof preferences.$inferInsert;
