/**
 * Tests for the generated-DDL parity validator (net 5).
 *
 * The matcher must catch divergence that survives the type-image parity test
 * (a column present in one chain only) while not false-positiving on the two
 * accepted cases: a Postgres identifier truncated to 63 bytes, and a
 * hand-written Postgres-only migration carrying a committed n/a marker on the
 * SQLite side. The chains are synthesized under a temp dir so the assertions
 * never depend on the live committed migrations.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DDL_PARITY_NA_MARKER_SUFFIX, findDdlParityFindings, normalizeSqlIdentifier } from './ddl-parity-validator.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * A single migration to synthesize into a chain: its tag and SQL body.
 */
interface SyntheticMigration {
  /** Journal tag (file stem without `.sql`). */
  readonly tag: string;
  /** SQL text written to `<tag>.sql`. */
  readonly sql: string;
}

/**
 * Write a synthetic chain dir (journal + `.sql` files + optional extra files)
 * under a fresh temp directory.
 * @param migrations - Migrations to write, in journal order.
 * @param extraFiles - Extra files (e.g. n/a markers) keyed by file name.
 * @returns Absolute path to the chain directory.
 */
function writeChain(migrations: readonly SyntheticMigration[], extraFiles: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ddl-parity-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'meta'), { recursive: true });
  for (const migration of migrations) {
    writeFileSync(join(root, `${migration.tag}.sql`), migration.sql);
  }
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(root, name), content);
  }
  writeFileSync(
    join(root, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', entries: migrations.map((m, idx) => ({ idx, tag: m.tag })) }),
  );
  return root;
}

describe('normalizeSqlIdentifier', () => {
  it('returns identifiers within 63 bytes unchanged', () => {
    expect(normalizeSqlIdentifier('idx_messages_content_tsv')).toBe('idx_messages_content_tsv');
  });

  it('truncates a >63-byte name to 63 bytes', () => {
    const long = 'a'.repeat(80);
    const normalized = normalizeSqlIdentifier(long);
    expect(Buffer.byteLength(normalized, 'utf8')).toBe(63);
    expect(normalized).toBe('a'.repeat(63));
  });

  it('never splits a multi-byte UTF-8 code point at the boundary', () => {
    // 'é' is 2 bytes; 31 of them = 62 bytes, the 32nd would cross 63.
    const name = 'é'.repeat(40);
    const normalized = normalizeSqlIdentifier(name);
    expect(Buffer.byteLength(normalized, 'utf8')).toBeLessThanOrEqual(63);
    // Re-decoding must not yield a replacement character (U+FFFD).
    expect(normalized).not.toContain('�');
    expect(normalized).toBe('é'.repeat(31));
  });
});

describe('findDdlParityFindings — parity in both directions', () => {
  it('reports nothing when both chains declare the same table and columns', () => {
    const sqliteChainDir = writeChain([
      {
        tag: '0000_init',
        sql: 'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);',
      },
    ]);
    const postgresChainDir = writeChain([
      {
        tag: '0000_init',
        sql: 'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);',
      },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });

  it('reports a column present in Postgres but missing from SQLite', () => {
    const sqliteChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL\n);' },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"label" text\n);' },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([
      { kind: 'missing-column', chain: 'sqlite', detail: 'widgets.label' },
    ]);
  });

  it('reports a column present in SQLite but missing from Postgres', () => {
    const sqliteChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`note` text\n);' },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL\n);' },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([
      { kind: 'missing-column', chain: 'postgres', detail: 'widgets.note' },
    ]);
  });

  it('reports a table present in one chain only', () => {
    const sqliteChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL\n);' },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL\n);' },
      { tag: '0001_extra', sql: 'CREATE TABLE "gadgets" (\n\t"id" text PRIMARY KEY NOT NULL\n);' },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([
      { kind: 'missing-table', chain: 'sqlite', detail: 'gadgets' },
    ]);
  });

  it('ignores ALTER TABLE ADD CONSTRAINT (FK additions add no column)', () => {
    const sqliteChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL\n);' },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL\n);' },
      {
        tag: '0001_fk',
        sql: 'ALTER TABLE "widgets" ADD CONSTRAINT "widgets_self_fk" FOREIGN KEY ("id") REFERENCES "widgets"("id");',
      },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });

  it('attributes SQLite __new_ recreate columns to the canonical table', () => {
    const sqliteChainDir = writeChain([
      {
        tag: '0000_init',
        sql: 'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL\n);',
      },
      {
        // table-recreate: shadow table carries the post-migration column set.
        tag: '0001_recreate',
        sql: 'CREATE TABLE `__new_widgets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`extra` text\n);\nALTER TABLE `__new_widgets` RENAME TO `widgets`;',
      },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_init', sql: 'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"extra" text\n);' },
    ]);
    // `extra` must be attributed to `widgets`, not `__new_widgets`, so parity holds.
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });
});

describe('findDdlParityFindings — hand-written tag handling', () => {
  /** Postgres SQL adding the hand-written content_tsv column + GIN index. */
  const contentTsvSql =
    'ALTER TABLE "messages" ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector(\'english\', coalesce(content_text, \'\'))) STORED;\nCREATE INDEX "idx_messages_content_tsv" ON "messages" USING gin ("content_tsv");';

  it('does not report the hand-written content_tsv column when the SQLite chain carries its n/a marker', () => {
    const sqliteChainDir = writeChain(
      [{ tag: '0000_messages', sql: 'CREATE TABLE `messages` (\n\t`message_id` text PRIMARY KEY NOT NULL\n);' }],
      { [`0001_messages_content_tsv${DDL_PARITY_NA_MARKER_SUFFIX}`]: '# intentionally no SQLite counterpart' },
    );
    const postgresChainDir = writeChain([
      { tag: '0000_messages', sql: 'CREATE TABLE "messages" (\n\t"message_id" text PRIMARY KEY NOT NULL\n);' },
      { tag: '0001_messages_content_tsv', sql: contentTsvSql },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });

  it('reports an unpaired hand-written tag when no SQLite counterpart or n/a marker exists', () => {
    const sqliteChainDir = writeChain([
      { tag: '0000_messages', sql: 'CREATE TABLE `messages` (\n\t`message_id` text PRIMARY KEY NOT NULL\n);' },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_messages', sql: 'CREATE TABLE "messages" (\n\t"message_id" text PRIMARY KEY NOT NULL\n);' },
      { tag: '0001_messages_content_tsv', sql: contentTsvSql },
    ]);
    const findings = findDdlParityFindings({ sqliteChainDir, postgresChainDir });
    expect(findings).toContainEqual({
      kind: 'missing-column',
      chain: 'sqlite',
      detail: 'messages.content_tsv',
    });
    expect(findings).toContainEqual(expect.objectContaining({ kind: 'unpaired-handwritten-sql', chain: 'postgres' }));
  });

  it('treats a same-stem .sql counterpart as a valid pairing for a hand-written tag', () => {
    // SQLite carries a real (drizzle-shaped) counterpart at the same stem that
    // provides the column, so neither a missing-column nor unpaired finding fires.
    const sqliteChainDir = writeChain([
      { tag: '0000_messages', sql: 'CREATE TABLE `messages` (\n\t`message_id` text PRIMARY KEY NOT NULL\n);' },
      { tag: '0001_messages_content_tsv', sql: 'ALTER TABLE `messages` ADD `content_tsv` text;' },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_messages', sql: 'CREATE TABLE "messages" (\n\t"message_id" text PRIMARY KEY NOT NULL\n);' },
      { tag: '0001_messages_content_tsv', sql: contentTsvSql },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });

  it('does not report the hand-written content_tsv index when the SQLite chain carries its n/a marker', () => {
    const sqliteChainDir = writeChain(
      [{ tag: '0000_messages', sql: 'CREATE TABLE `messages` (\n\t`message_id` text PRIMARY KEY NOT NULL\n);' }],
      { [`0001_messages_content_tsv${DDL_PARITY_NA_MARKER_SUFFIX}`]: '# intentionally no SQLite counterpart' },
    );
    const postgresChainDir = writeChain([
      { tag: '0000_messages', sql: 'CREATE TABLE "messages" (\n\t"message_id" text PRIMARY KEY NOT NULL\n);' },
      // The hand-written tag introduces both the content_tsv column and its GIN index.
      { tag: '0001_messages_content_tsv', sql: contentTsvSql },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });
});

describe('findDdlParityFindings — index parity', () => {
  it('reports nothing when both chains declare the same indexes', () => {
    const sqliteChainDir = writeChain([
      {
        tag: '0000_init',
        sql:
          'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);\n' +
          'CREATE INDEX `idx_widgets_name` ON `widgets` (`name`);',
      },
    ]);
    const postgresChainDir = writeChain([
      {
        tag: '0000_init',
        sql:
          'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);\n' +
          'CREATE INDEX "idx_widgets_name" ON "widgets" USING btree ("name");',
      },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });

  it('matches a SQLite CREATE UNIQUE INDEX against a Postgres table-level UNIQUE constraint of the same name', () => {
    // drizzle-kit emits the SQLite unique index standalone but folds the
    // Postgres equivalent into a CONSTRAINT ... UNIQUE in the CREATE TABLE body.
    const sqliteChainDir = writeChain([
      {
        tag: '0000_init',
        sql:
          'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`slug` text NOT NULL\n);\n' +
          'CREATE UNIQUE INDEX `uniq_widgets_slug` ON `widgets` (`slug`);',
      },
    ]);
    const postgresChainDir = writeChain([
      {
        tag: '0000_init',
        sql:
          'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"slug" text NOT NULL,\n' +
          '\tCONSTRAINT "uniq_widgets_slug" UNIQUE("slug")\n);',
      },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });

  it('reports an index present in SQLite but missing from Postgres', () => {
    const sqliteChainDir = writeChain([
      {
        tag: '0000_init',
        sql:
          'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);\n' +
          'CREATE INDEX `idx_widgets_name` ON `widgets` (`name`);',
      },
    ]);
    const postgresChainDir = writeChain([
      {
        tag: '0000_init',
        sql: 'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);',
      },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([
      { kind: 'missing-index', chain: 'postgres', detail: 'idx_widgets_name' },
    ]);
  });

  it('reports an index present in Postgres but missing from SQLite', () => {
    const sqliteChainDir = writeChain([
      {
        tag: '0000_init',
        sql: 'CREATE TABLE `widgets` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);',
      },
    ]);
    const postgresChainDir = writeChain([
      {
        tag: '0000_init',
        sql:
          'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"name" text NOT NULL\n);\n' +
          'CREATE INDEX "idx_widgets_name" ON "widgets" USING btree ("name");',
      },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([
      { kind: 'missing-index', chain: 'sqlite', detail: 'idx_widgets_name' },
    ]);
  });

  it('truncates a >63-byte index/column identifier so it never false-positives across chains', () => {
    const longColumn = `col_${'x'.repeat(80)}`;
    const truncated = normalizeSqlIdentifier(longColumn);
    expect(Buffer.byteLength(truncated, 'utf8')).toBe(63);
    // SQLite keeps the full name; Postgres truncates at 63 bytes. Both must
    // normalize to the same key, so no missing-column finding is produced.
    const sqliteChainDir = writeChain([
      { tag: '0000_init', sql: `CREATE TABLE \`widgets\` (\n\t\`${longColumn}\` text\n);` },
    ]);
    const postgresChainDir = writeChain([
      { tag: '0000_init', sql: `CREATE TABLE "widgets" (\n\t"${truncated}" text\n);` },
    ]);
    expect(findDdlParityFindings({ sqliteChainDir, postgresChainDir })).toEqual([]);
  });
});
