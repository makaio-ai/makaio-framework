/**
 * Shared test database helper for native-session-supervisor tests.
 * @packageDocumentation
 */

import { sql } from 'drizzle-orm';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type { MakaioDatabase } from '@makaio/storage-drizzle';

/**
 * Context returned by {@link createTestDb}.
 */
export interface TestDbContext {
  /** The in-memory Drizzle database instance. */
  db: MakaioDatabase;
  /** Closes and releases the in-memory database. */
  close: () => void;
}

/**
 * Creates an in-memory SQLite database with the supervisor_runtimes table
 * and all associated indexes.
 *
 * COUPLING NOTE: The DDL below is manually kept in sync with
 * `src/storage/schema.ts`. SQLite does not enforce enum constraints natively,
 * so the `status` column omits the check — the TypeScript type system
 * (via Drizzle's enum typing) prevents invalid values at the application layer.
 *
 * Once a Drizzle migration is generated for `supervisor_runtimes`
 * (`yarn workspace @makaio/storage-migrations db:generate`), this helper
 * should be replaced with `applyMigrations(db, migrations)` from
 * `@makaio/storage-migrations` so the schema is derived from the canonical
 * migration SQL rather than being duplicated here.
 * @returns Database context with db and close function.
 */
export async function createTestDb(): Promise<TestDbContext> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS supervisor_runtimes (
      supervisor_session_id TEXT PRIMARY KEY,
      client_id             TEXT NOT NULL,
      pid                   INTEGER,
      status                TEXT NOT NULL,
      cwd                   TEXT NOT NULL,
      command               TEXT NOT NULL,
      args_json             TEXT NOT NULL,
      env_json              TEXT,
      session_id            TEXT,
      adapter_session_id    TEXT,
      started_at            INTEGER NOT NULL,
      stopped_at            INTEGER,
      metadata_json         TEXT
    )
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS supervisor_runtimes_session_id_idx
    ON supervisor_runtimes(session_id)
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS supervisor_runtimes_adapter_session_id_idx
    ON supervisor_runtimes(adapter_session_id)
  `);

  await db.run(sql`
    CREATE INDEX IF NOT EXISTS supervisor_runtimes_status_idx
    ON supervisor_runtimes(status)
  `);

  return { db, close };
}
