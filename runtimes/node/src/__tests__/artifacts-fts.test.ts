/**
 * Tests for the content-backed artifacts FTS5 infrastructure.
 *
 * Verifies the generated `content_text` column, FTS sync triggers, the
 * `rebuild` command, and the round-trip search behaviour created by
 * {@link setupArtifactsFtsSync} and {@link createArtifactsFts5Tables}.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { setupArtifactsFtsSync, createArtifactsFts5Tables } from '@makaio/runtime-node';

// ---------------------------------------------------------------------------
// Minimal schema SQL for the artifacts FTS test database
// ---------------------------------------------------------------------------

const CREATE_ARTIFACTS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS extension_artifacts_items (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    project_id TEXT,
    workstream_id TEXT,
    worktree_id TEXT,
    scope TEXT NOT NULL,
    type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_path TEXT,
    content TEXT,
    extracted_text TEXT,
    extracted_at INTEGER,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

// ---------------------------------------------------------------------------
// Test DB factory — fresh file-based DB per test for isolation
// ---------------------------------------------------------------------------

interface FtsTestContext {
  db: MakaioDatabase;
  cleanup: () => void;
}

/**
 * Creates a temporary file-based SQLite database with the
 * `extension_artifacts_items` table and a fully set-up artifacts FTS stack
 * (generated column, FTS5 virtual table, and sync triggers).
 * @returns Test context with db and cleanup function
 */
async function createArtifactsFtsTestDb(): Promise<FtsTestContext> {
  const dbPath = path.join(os.tmpdir(), `makaio-artifacts-fts-test-${crypto.randomUUID()}.db`);
  const { db, close } = await createDatabaseClient({ url: `file:${dbPath}` });

  await db.run(CREATE_ARTIFACTS_TABLE_SQL);

  // createArtifactsFts5Tables requires the backing table to exist.
  // It will create the FTS virtual table and call setupArtifactsFtsSync.
  await createArtifactsFts5Tables(db);

  const cleanup = (): void => {
    close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
  };

  return { db, cleanup };
}

/**
 * Inserts an artifact row directly into the backing table.
 * Triggers sync the row into `artifacts_fts` automatically.
 * @param db - Drizzle database instance
 * @param id - Unique artifact identifier
 * @param content - Raw content text (used when extractedText is absent)
 * @param extractedText - Optional extracted text (takes precedence over content in content_text)
 */
async function insertArtifact(
  db: MakaioDatabase,
  id: string,
  content: string | null,
  extractedText: string | null = null,
): Promise<void> {
  const now = Date.now();
  await db.run(sql`
    INSERT INTO extension_artifacts_items
      (id, scope, type, mime_type, content, extracted_text, created_at, updated_at)
    VALUES
      (${id}, 'session', 'document', 'text/plain', ${content}, ${extractedText}, ${now}, ${now})
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('artifacts FTS5 — content_text generated column', () => {
  let ctx: FtsTestContext;

  beforeEach(async () => {
    ctx = await createArtifactsFtsTestDb();
  });

  afterEach(() => ctx.cleanup());

  it('Scenario 1: content_text equals extracted_text when both are set (COALESCE prefers extracted_text)', async () => {
    await insertArtifact(ctx.db, 'art-1', 'raw content blob', 'extracted superior text');

    const [row] = await ctx.db.all<{ content_text: string }>(sql`
      SELECT content_text FROM extension_artifacts_items WHERE id = 'art-1'
    `);

    expect(row?.content_text).toBe('extracted superior text');
  });

  it('Scenario 2: content_text falls back to content when extracted_text is NULL', async () => {
    await insertArtifact(ctx.db, 'art-2', 'only raw content', null);

    const [row] = await ctx.db.all<{ content_text: string }>(sql`
      SELECT content_text FROM extension_artifacts_items WHERE id = 'art-2'
    `);

    expect(row?.content_text).toBe('only raw content');
  });
});

describe('artifacts FTS5 — snippet() and MATCH queries', () => {
  let ctx: FtsTestContext;

  beforeEach(async () => {
    ctx = await createArtifactsFtsTestDb();
  });

  afterEach(() => ctx.cleanup());

  it('Scenario 3: snippet() returns highlighted text after content-backed insert', async () => {
    await insertArtifact(ctx.db, 'art-3', 'TypeScript generics and conditional types are powerful', null);

    const rows = await ctx.db.all<{ excerpt: string }>(sql`
      SELECT snippet(artifacts_fts, 0, '<mark>', '</mark>', '...', 40) AS excerpt
      FROM artifacts_fts
      WHERE artifacts_fts MATCH 'typescript'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.excerpt).toContain('<mark>');
  });

  it('Scenario 4: rebuild command reconstructs index so MATCH queries work', async () => {
    // Insert two rows to populate the FTS index normally.
    await insertArtifact(ctx.db, 'art-a', 'authentication flow implementation', null);
    await insertArtifact(ctx.db, 'art-b', 'JWT token refresh strategy', null);

    // Corrupt the FTS index by deleting all entries from the shadow table
    // using the special 'delete-all' command (FTS5 internal reset).
    await ctx.db.run(sql`INSERT INTO artifacts_fts(artifacts_fts) VALUES ('delete-all')`);

    // After delete-all, MATCH should return nothing.
    const beforeRebuild = await ctx.db.all<{ rowid: number }>(sql`
      SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH 'authentication'
    `);
    expect(beforeRebuild).toHaveLength(0);

    // Rebuild from backing table.
    await ctx.db.run(sql`INSERT INTO artifacts_fts(artifacts_fts) VALUES ('rebuild')`);

    // After rebuild, MATCH should find the row again.
    const afterRebuild = await ctx.db.all<{ rowid: number }>(sql`
      SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH 'authentication'
    `);
    expect(afterRebuild).toHaveLength(1);
  });
});

describe('artifacts FTS5 — INSERT / UPDATE / DELETE trigger sync', () => {
  let ctx: FtsTestContext;

  beforeEach(async () => {
    ctx = await createArtifactsFtsTestDb();
  });

  afterEach(() => ctx.cleanup());

  it('Scenario 5: INSERT trigger — inserted artifact appears in FTS MATCH', async () => {
    await insertArtifact(ctx.db, 'art-insert', 'concurrent programming patterns', null);

    const rows = await ctx.db.all<{ id: string }>(sql`
      SELECT ai.id
      FROM artifacts_fts
      JOIN extension_artifacts_items ai ON ai.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH 'concurrent'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('art-insert');
  });

  it('Scenario 6: UPDATE extracted_text — FTS reflects the new content_text', async () => {
    await insertArtifact(ctx.db, 'art-update', 'original content only', null);

    // Verify original content is found.
    const beforeUpdate = await ctx.db.all<{ id: string }>(sql`
      SELECT ai.id
      FROM artifacts_fts
      JOIN extension_artifacts_items ai ON ai.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH 'original'
    `);
    expect(beforeUpdate).toHaveLength(1);

    // Update extracted_text — the UPDATE trigger must remove the old FTS entry
    // and insert the new one.
    await ctx.db.run(sql`
      UPDATE extension_artifacts_items
      SET extracted_text = 'completely different extracted text'
      WHERE id = 'art-update'
    `);

    // Old term should no longer match.
    const oldTermRows = await ctx.db.all<{ id: string }>(sql`
      SELECT ai.id
      FROM artifacts_fts
      JOIN extension_artifacts_items ai ON ai.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH 'original'
    `);
    expect(oldTermRows).toHaveLength(0);

    // New term from extracted_text must match.
    const newTermRows = await ctx.db.all<{ id: string }>(sql`
      SELECT ai.id
      FROM artifacts_fts
      JOIN extension_artifacts_items ai ON ai.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH 'extracted'
    `);
    expect(newTermRows).toHaveLength(1);
    expect(newTermRows[0]?.id).toBe('art-update');
  });

  it('Scenario 7: DELETE trigger — deleted artifact is removed from FTS', async () => {
    await insertArtifact(ctx.db, 'art-delete', 'microservice architecture patterns', null);

    // Verify it appears before deletion.
    const beforeDelete = await ctx.db.all<{ id: string }>(sql`
      SELECT ai.id
      FROM artifacts_fts
      JOIN extension_artifacts_items ai ON ai.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH 'microservice'
    `);
    expect(beforeDelete).toHaveLength(1);

    // Delete the artifact — the DELETE trigger must remove the FTS entry.
    await ctx.db.run(sql`DELETE FROM extension_artifacts_items WHERE id = 'art-delete'`);

    // FTS MATCH must return nothing after deletion.
    const afterDelete = await ctx.db.all<{ id: string }>(sql`
      SELECT rowid FROM artifacts_fts
      WHERE artifacts_fts MATCH 'microservice'
    `);
    expect(afterDelete).toHaveLength(0);
  });
});

describe('artifacts FTS5 — setupArtifactsFtsSync is idempotent', () => {
  let ctx: FtsTestContext;

  beforeEach(async () => {
    ctx = await createArtifactsFtsTestDb();
  });

  afterEach(() => ctx.cleanup());

  it('calling setupArtifactsFtsSync again does not corrupt existing data or triggers', async () => {
    await insertArtifact(ctx.db, 'art-idem', 'idempotency test content', null);

    // Call setupArtifactsFtsSync a second time — it must be a no-op for DDL
    // (IF NOT EXISTS guards + PRAGMA column check) and safe to call again.
    await setupArtifactsFtsSync(ctx.db);

    const rows = await ctx.db.all<{ id: string }>(sql`
      SELECT ai.id
      FROM artifacts_fts
      JOIN extension_artifacts_items ai ON ai.rowid = artifacts_fts.rowid
      WHERE artifacts_fts MATCH 'idempotency'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('art-idem');
  });
});
