/**
 * Read all Drizzle migration entries from the local drizzle/ folder.
 *
 * Returns structured {@link MigrationMeta} objects suitable for
 * {@link applyMigrations}. This is the filesystem-based reader used in
 * dev mode and by CLI tools. In bundled builds (Electron), the esbuild
 * plugin replaces this module with embedded constants.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Structured migration entry matching Drizzle ORM's internal format.
 *
 * Produced by {@link readMigrations} (filesystem) or embedded at build
 * time by the esbuild plugin.
 */
export interface MigrationMeta {
  /** Stable journal tag, matching the migration SQL filename without extension. */
  tag: string;
  /** SQL statements split on `"--> statement-breakpoint"`. */
  sql: string[];
  /** Epoch milliseconds from the journal entry's `when` field. */
  folderMillis: number;
  /** SHA-256 hex digest of the raw `.sql` file content. */
  hash: string;
  /** Whether the SQL file uses statement breakpoints. */
  bps: boolean;
}

/**
 * Dual-source input for migration reads.
 *
 * `migrationsDir` is the filesystem discovery path used by normal Node/Bun
 * hosts. `migrationSourceId` is a stable runtime identity used by bundled
 * hosts whose packaged filesystem layout no longer matches the original source
 * directory structure. The filesystem reader ignores `migrationSourceId`; the
 * bundled replacement can prefer it while falling back to `migrationsDir`.
 */
export interface MigrationReadSource {
  /** Filesystem path to the `drizzle/` folder. */
  readonly migrationsDir?: string;
  /** Stable bundled-host identity for the migration bundle. */
  readonly migrationSourceId?: string;
}

/**
 * Input accepted by {@link readMigrations}.
 */
export type MigrationReadInput = string | MigrationReadSource;

/**
 * Read all Drizzle migrations from a `drizzle/` folder.
 *
 * Reads `meta/_journal.json`, then each `.sql` file referenced by the
 * journal. Returns the same `MigrationMeta[]` shape that Drizzle's internal
 * `readMigrationFiles()` produces.
 * @param source - Either an absolute `drizzle/` folder path or a dual-source
 *   object. Filesystem mode reads from `source.migrationsDir`; bundled mode can
 *   instead use `source.migrationSourceId`.
 * @returns Ordered array of migration entries.
 * @throws If `_journal.json` or any referenced `.sql` file is missing.
 */
export function readMigrations(
  source: MigrationReadInput = path.resolve(import.meta.dirname, '../drizzle'),
): MigrationMeta[] {
  const migrationsDir =
    typeof source === 'string' ? source : (source.migrationsDir ?? path.resolve(import.meta.dirname, '../drizzle'));
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json');

  if (!existsSync(journalPath)) {
    throw new Error(`Cannot find migrations journal at ${journalPath}`);
  }

  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries: Array<{ when: number; tag: string; breakpoints: boolean }>;
  };

  return journal.entries.map((entry) => {
    const sqlPath = path.join(migrationsDir, `${entry.tag}.sql`);
    const raw = readFileSync(sqlPath, 'utf-8');
    return {
      tag: entry.tag,
      sql: raw.split('--> statement-breakpoint'),
      folderMillis: entry.when,
      hash: createHash('sha256').update(raw).digest('hex'),
      bps: entry.breakpoints,
    };
  });
}
