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

/** Options for applying framework central migrations. */
export interface RunMigrationsOptions {
  /** Optional filesystem path to a bundled framework `drizzle/` migrations directory. */
  readonly migrationsDir?: string;
}

/**
 * Run all database migrations.
 *
 * 1. Runs Drizzle-generated migrations for all framework tables
 * 2. Creates framework-owned FTS5 virtual tables and triggers (not supported by Drizzle)
 * @param db - Drizzle database instance
 * @param options - Optional migration source overrides for bundled hosts.
 */
export async function runMigrations(db: MakaioDatabase, options: RunMigrationsOptions = {}): Promise<void> {
  const migrations = readMigrations(options.migrationsDir);
  await applyMigrations(db, migrations);

  // Framework-owned FTS5 virtual tables (Drizzle doesn't support virtual tables)
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

  // Unconditional by design: rebuilding repairs drift from older boots that
  // ran before the sync triggers existed. A count-based skip would preserve a
  // stale or corrupted FTS index.
  await db.run(sql`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
}

/**
 * Create all framework-owned FTS5 virtual tables and triggers for full-text search.
 *
 * These are idempotent (IF NOT EXISTS) and run after Drizzle migrations.
 * Exported for direct use in tests that need to set up FTS5 without running
 * the full Drizzle migration suite.
 * @param db - Drizzle database instance
 */
export async function createFts5Tables(db: MakaioDatabase): Promise<void> {
  await createMessagesFts5Tables(db);
}
