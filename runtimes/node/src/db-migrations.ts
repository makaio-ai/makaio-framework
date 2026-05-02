/**
 * Database migrations for NodeRuntime session persistence.
 *
 * Uses Drizzle's migration system for schema changes.
 * FTS5 virtual tables are created separately (Drizzle doesn't support virtual tables).
 */
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';

/**
 * Run all database migrations.
 *
 * 1. Runs Drizzle-generated migrations for all framework tables
 * 2. Creates FTS5 virtual tables and triggers (not supported by Drizzle)
 * @param db - Drizzle database instance
 */
export async function runMigrations(db: MakaioDatabase): Promise<void> {
  // Run Drizzle migrations from @makaio/storage-migrations
  const migrations = readMigrations();
  await applyMigrations(db, migrations);

  // FTS5 virtual tables (Drizzle doesn't support virtual tables)
  await createFts5Tables(db);
}

/**
 * Create FTS5 virtual table and triggers for message full-text search.
 *
 * Idempotent (IF NOT EXISTS). Requires the `messages` table to already exist.
 * Exported for direct use in tests that exercise only message search without
 * running the full Drizzle migration suite.
 * @param db - Drizzle database instance
 */
export async function createMessagesFts5Tables(db: MakaioDatabase): Promise<void> {
  // Content-backed FTS5 table — SQLite validates the backing table at CREATE time.
  await db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      session_id,
      content_text,
      content='messages',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);

  // Triggers for FTS5 sync with messages table
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, session_id, content_text)
      VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
    END
  `);

  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
      VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
    END
  `);

  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, session_id, content_text)
      VALUES('delete', OLD.rowid, OLD.session_id, OLD.content_text);
      INSERT INTO messages_fts(rowid, session_id, content_text)
      VALUES (NEW.rowid, NEW.session_id, NEW.content_text);
    END
  `);

  // Rebuild unconditionally so pre-existing rows are indexed and any drift is
  // repaired if startup ever ran without the sync triggers installed.
  await db.run(sql`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
}

/**
 * Create FTS5 virtual table and triggers for artifact content full-text search.
 *
 * Uses a content-backed FTS5 table pointing at `extension_artifacts_items` via the
 * generated `content_text` column (added by {@link setupArtifactsFtsSync} on first
 * startup, since SQLite has no `ADD COLUMN IF NOT EXISTS`).
 * Content-backed tables store no duplicate text — the index is rebuilt from the
 * backing table on demand, preventing data drift.
 *
 * Idempotent (IF NOT EXISTS). When `extension_artifacts_items` already exists, the
 * FTS index is fully rebuilt from the backing table; otherwise the rebuild step
 * is skipped. This makes the function safe to call during Drizzle migrations
 * before the plugin storage table is registered.
 * Exported for direct use in tests that exercise only artifact search without
 * running the full Drizzle migration suite.
 * @param db - Drizzle database instance
 */
export async function createArtifactsFts5Tables(db: MakaioDatabase): Promise<void> {
  await db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
      content_text,
      content='extension_artifacts_items',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);

  // Triggers and initial population require extension_artifacts_items to exist.
  // That table is registered by the artifacts plugin after migrations run, so it
  // may be absent in migration-only or test environments that don't load the plugin.
  // Check at the application level before issuing any SQL that references it.
  const [tableRow] = await db.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'extension_artifacts_items'
  `);

  if (tableRow) {
    await setupArtifactsFtsSync(db);
  }
}

/**
 * Set up FTS5 synchronisation triggers and backfill for artifacts.
 *
 * Must be called **after** `extension_artifacts_items` has been created (i.e. after
 * the artifacts plugin storage is initialised). On each call it:
 *
 * 1. Adds the `content_text` generated column if absent (idempotent via PRAGMA
 *    check — SQLite has no `ADD COLUMN IF NOT EXISTS`).
 * 2. Installs the three FTS sync triggers (INSERT / UPDATE / DELETE).
 * 3. Issues a full `rebuild` so the index always reflects the backing table,
 *    self-correcting any drift from a previous run with missing triggers.
 *
 * Trigger idiom for content-backed FTS5: deletions are signalled by inserting a
 * row with the special `'delete'` command into the FTS table itself, rather than
 * issuing a direct `DELETE`. This allows FTS5 to update its internal B-tree
 * without touching the backing table.
 *
 * Exported so that the node runtime can call it explicitly after plugin storage
 * is registered, and so that targeted test suites can set up only the artifacts
 * FTS stack without running the full Drizzle migration suite.
 * @param db - Drizzle database instance
 */
export async function setupArtifactsFtsSync(db: MakaioDatabase): Promise<void> {
  // Ensure the generated column exists. SQLite has no IF NOT EXISTS for
  // ALTER TABLE, so check column presence via PRAGMA before issuing the DDL.
  // PRAGMA table_xinfo must be used instead of table_info because libsql
  // omits generated (hidden=2/3) columns from table_info results.
  const columns = await db.all<{ name: string }>(sql`PRAGMA table_xinfo(extension_artifacts_items)`);
  const hasContentText = columns.some((col) => col.name === 'content_text');
  if (!hasContentText) {
    await db.run(sql`
      ALTER TABLE extension_artifacts_items
      ADD COLUMN content_text TEXT GENERATED ALWAYS AS (COALESCE(extracted_text, content)) VIRTUAL
    `);
  }

  // Triggers for FTS5 sync with extension_artifacts_items table
  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON extension_artifacts_items BEGIN
      INSERT INTO artifacts_fts(rowid, content_text)
      VALUES (NEW.rowid, NEW.content_text);
    END
  `);

  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON extension_artifacts_items BEGIN
      INSERT INTO artifacts_fts(artifacts_fts, rowid, content_text)
      VALUES ('delete', OLD.rowid, OLD.content_text);
      INSERT INTO artifacts_fts(rowid, content_text)
      VALUES (NEW.rowid, NEW.content_text);
    END
  `);

  await db.run(sql`
    CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON extension_artifacts_items BEGIN
      INSERT INTO artifacts_fts(artifacts_fts, rowid, content_text)
      VALUES ('delete', OLD.rowid, OLD.content_text);
    END
  `);

  // Unconditional by design: rebuilds the FTS index from extension_artifacts_items
  // on every startup as a self-healing mechanism. A count-based guard ("skip if
  // rows > 0") would silently leave a corrupted index unrepaired. Cost is
  // proportional to table size but negligible for artifact tables in practice.
  await db.run(sql`INSERT INTO artifacts_fts(artifacts_fts) VALUES ('rebuild')`);
}

/**
 * Create all FTS5 virtual tables and triggers for full-text search.
 *
 * Delegates to {@link createMessagesFts5Tables} and {@link createArtifactsFts5Tables}.
 * These are idempotent (IF NOT EXISTS) and run after Drizzle migrations.
 * Exported for direct use in tests that need to set up FTS5 without running
 * the full Drizzle migration suite.
 * @param db - Drizzle database instance
 */
export async function createFts5Tables(db: MakaioDatabase): Promise<void> {
  await createMessagesFts5Tables(db);
  await createArtifactsFts5Tables(db);
}
