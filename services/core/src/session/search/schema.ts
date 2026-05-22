/**
 * FTS5 virtual table for full-text search across messages.
 *
 * Uses content-backed FTS5 with automatic sync via triggers.
 * Created in db-migrations.ts (Drizzle doesn't support virtual tables).
 *
 * Schema:
 * ```sql
 * CREATE VIRTUAL TABLE messages_fts USING fts5(
 *   session_id,
 *   content_text,
 *   content='messages',
 *   content_rowid='rowid',
 *   tokenize='porter unicode61'
 * );
 * ```
 *
 * Triggers automatically sync inserts/updates/deletes from the messages table.
 * No manual indexing required.
 *
 * Query pattern (join via rowid):
 * ```sql
 * SELECT m.* FROM messages m
 * WHERE m.rowid IN (
 *   SELECT rowid FROM messages_fts
 *   WHERE messages_fts MATCH ?
 * )
 * ```
 */

// No exports needed - FTS is handled via raw SQL in handlers
