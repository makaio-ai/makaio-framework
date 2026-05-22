import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Import cursors table schema.
 *
 * Tracks byte offsets for incremental log file import.
 * Enables resuming import from the last processed position after restarts.
 */
export const importCursors = sqliteTable('import_cursors', {
  /**
   * Absolute path to the log file (primary key).
   * Example: ~/.claude/projects/-Users-foo-project/abc123.jsonl
   */
  filePath: text('file_path').primaryKey(),

  /**
   * Number of bytes successfully read and processed.
   * Import resumes from this offset on next run.
   */
  bytesRead: integer('bytes_read').notNull(),

  /**
   * ISO 8601 timestamp of file's last modification when cursor was saved.
   * Used to detect file rotation (file shrunk = rotation occurred).
   */
  lastModified: text('last_modified').notNull(),

  /**
   * Timestamp when this cursor was last updated.
   * Stored as Unix timestamp in milliseconds.
   */
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Type for inserting a new import cursor.
 */
export type InsertImportCursor = typeof importCursors.$inferInsert;

/**
 * Type for a selected import cursor row.
 */
export type SelectImportCursor = typeof importCursors.$inferSelect;
