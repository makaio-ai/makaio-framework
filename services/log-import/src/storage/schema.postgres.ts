import { pgTable, text } from 'drizzle-orm/pg-core';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';

/**
 * Postgres twin for the `log_import_settings` table.
 *
 * Column layout mirrors the canonical SQLite schema exactly; only the
 * underlying column builders differ (epochMs → bigint, text stays text).
 */
export const logImportSettings = pgTable('log_import_settings', {
  /** Adapter name (e.g., 'claude-code'). Primary key. */
  adapterName: text('adapter_name').primaryKey(),

  /** Import mode: 'disabled' | 'discover' | 'import'. */
  mode: text('mode', { enum: ['disabled', 'discover', 'import'] })
    .notNull()
    .default('disabled'),

  /** Timestamp in milliseconds when the row was first created. */
  createdAt: epochMs('created_at').notNull(),

  /** Timestamp in milliseconds when the row was last updated. */
  updatedAt: epochMs('updated_at').notNull(),
});
