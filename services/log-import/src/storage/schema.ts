import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Drizzle schema for the `log_import_settings` table.
 *
 * Stores per-adapter global import mode. One row per adapter — `adapter_name`
 * is the primary key. Hosts that need scoped overrides should provide their own
 * extended storage subjects and tables.
 */
export const logImportSettingsDual = defineDualTable('log_import_settings', (c) => ({
  /** Adapter name (e.g., 'claude-code'). Primary key. */
  adapterName: c.text('adapter_name').primaryKey(),

  /** Import mode: 'disabled' | 'discover' | 'import'. */
  mode: c
    .textEnum('mode', { enum: ['disabled', 'discover', 'import'] as const })
    .notNull()
    .default('disabled'),

  /** Timestamp in milliseconds when the row was first created. */
  createdAt: c.epochMs('created_at').notNull(),

  /** Timestamp in milliseconds when the row was last updated. */
  updatedAt: c.epochMs('updated_at').notNull(),
}));

/** SQLite face of the `log_import_settings` table (canonical schema). */
export const logImportSettings = logImportSettingsDual.sqlite;

/** Type for inserting a new log import settings row. */
export type InsertLogImportSettings = typeof logImportSettings.$inferInsert;

/** Type for a selected log import settings row. */
export type SelectLogImportSettings = typeof logImportSettings.$inferSelect;
