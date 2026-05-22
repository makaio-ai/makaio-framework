import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema for the `log_import_settings` table.
 *
 * Stores per-adapter global import mode. One row per adapter — `adapter_name`
 * is the primary key. Hosts that need scoped overrides should provide their own
 * extended storage subjects and tables.
 */
export const logImportSettings = sqliteTable('log_import_settings', {
  /** Adapter name (e.g., 'claude-code'). Primary key. */
  adapterName: text('adapter_name').primaryKey(),

  /** Import mode: 'disabled' | 'discover' | 'import'. */
  mode: text('mode', { enum: ['disabled', 'discover', 'import'] })
    .notNull()
    .default('disabled'),

  /** Timestamp in milliseconds when the row was first created. */
  createdAt: integer('created_at').notNull(),

  /** Timestamp in milliseconds when the row was last updated. */
  updatedAt: integer('updated_at').notNull(),
});

/** Type for inserting a new log import settings row. */
export type InsertLogImportSettings = typeof logImportSettings.$inferInsert;

/** Type for a selected log import settings row. */
export type SelectLogImportSettings = typeof logImportSettings.$inferSelect;
