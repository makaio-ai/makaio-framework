/**
 * Postgres twin schema for the import cursors table.
 *
 * Congruent twin of `schema.ts` — identical SQL names, column types mapped to
 * Postgres equivalents via the shared column bundles. Row types are exclusively
 * owned by the canonical `schema.ts`; this file exports table objects only.
 */
import { pgTable, text, bigint } from 'drizzle-orm/pg-core';
import { epochMs } from '@makaio/storage-drizzle/columns/postgres';

/** Postgres twin of the `import_cursors` table. */
export const importCursors = pgTable('import_cursors', {
  /**
   * Absolute path to the log file (primary key).
   * Example: ~/.claude/projects/-Users-foo-project/abc123.jsonl
   */
  filePath: text('file_path').primaryKey(),

  /**
   * Number of bytes successfully read and processed.
   * Stored as int8 — matches SQLite INTEGER's 64-bit range on the canonical
   * side. `'number'` mode bounds values at 2^53, the same bound the JS write
   * path (`stat.size`) has.
   */
  bytesRead: bigint('bytes_read', { mode: 'number' }).notNull(),

  /**
   * ISO 8601 timestamp of file's last modification when cursor was saved.
   * Used to detect file rotation (file shrunk = rotation occurred).
   */
  lastModified: text('last_modified').notNull(),

  /** Timestamp when this cursor was last updated (Unix ms). */
  updatedAt: epochMs('updated_at').notNull(),
});
