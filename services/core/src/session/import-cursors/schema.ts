import { defineDualTable } from '@makaio/storage-drizzle';

/**
 * Import cursors table schema.
 *
 * Tracks byte offsets for incremental log file import.
 * Enables resuming import from the last processed position after restarts.
 */
export const importCursorsDual = defineDualTable('import_cursors', (c) => ({
  /**
   * Absolute path to the log file (primary key).
   * Example: ~/.claude/projects/-Users-foo-project/abc123.jsonl
   */
  filePath: c.text('file_path').primaryKey(),

  /**
   * Number of bytes successfully read and processed.
   * Import resumes from this offset on next run.
   * SQLite INTEGER is int8-capable; the Postgres face mirrors this with
   * `bigint` ('number' mode) so large log files keep their resume cursor on
   * both dialects. `'number'` mode bounds values at 2^53, the same bound the
   * JS write path (`stat.size`) has.
   */
  bytesRead: c.int8('bytes_read').notNull(),

  /**
   * ISO 8601 timestamp of file's last modification when cursor was saved.
   * Used to detect file rotation (file shrunk = rotation occurred).
   */
  lastModified: c.text('last_modified').notNull(),

  /**
   * Timestamp when this cursor was last updated.
   * Stored as Unix timestamp in milliseconds.
   */
  updatedAt: c.epochMs('updated_at').notNull(),
}));

/** SQLite face of the `import_cursors` table (canonical schema). */
export const importCursors = importCursorsDual.sqlite;

/**
 * Type for inserting a new import cursor.
 */
export type InsertImportCursor = typeof importCursors.$inferInsert;

/**
 * Type for a selected import cursor row.
 */
export type SelectImportCursor = typeof importCursors.$inferSelect;
