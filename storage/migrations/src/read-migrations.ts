/**
 * Read all Drizzle migration entries from a local migrations folder —
 * defaulting to the package-local chain that matches the expected dialect.
 *
 * Returns structured {@link MigrationMeta} objects suitable for
 * {@link applyMigrations}. This is the filesystem-based reader used in
 * dev mode and by CLI tools. In bundled builds (Electron), the esbuild
 * plugin replaces this module with embedded constants.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { StorageDialect } from '@makaio/storage-drizzle';
import { getMigrationsFolder } from './run-migrations.js';

/**
 * Journal `dialect` values drizzle-kit writes, keyed by storage dialect.
 */
const JOURNAL_DIALECTS: Readonly<Record<StorageDialect, string>> = {
  sqlite: 'sqlite',
  postgres: 'postgresql',
};

/**
 * Raised when a migration journal targets a different SQL dialect than the
 * database the migrations would be applied to.
 *
 * Application paths derive the expected dialect from the live database
 * handle, so a misconfigured migrations directory fails as one actionable
 * boot error before any DDL runs, instead of corrupting the schema with
 * foreign-dialect SQL.
 *
 * Match by `error.name === 'MigrationDialectMismatchError'` where class
 * identity may not be shared (for example across separately bundled copies
 * of this package).
 */
export class MigrationDialectMismatchError extends Error {
  /** Storage dialect of the database the migrations were read for. */
  public readonly expectedDialect: StorageDialect;

  /** `dialect` value found in the journal, or `undefined` when absent. */
  public readonly journalDialect: string | undefined;

  /**
   * Create a dialect-mismatch error for a migration journal.
   * @param expectedDialect - Storage dialect of the target database.
   * @param journalDialect - `dialect` value recorded in the journal, if any.
   * @param journalPath - Path of the journal that failed validation.
   */
  public constructor(expectedDialect: StorageDialect, journalDialect: string | undefined, journalPath: string) {
    super(
      `Migration journal at ${journalPath} declares dialect '${journalDialect ?? 'unknown'}', ` +
        `but the target database speaks '${expectedDialect}'. Point the runner at a migrations ` +
        `directory generated for '${expectedDialect}' (journal dialect '${JOURNAL_DIALECTS[expectedDialect]}').`,
    );
    this.name = 'MigrationDialectMismatchError';
    this.expectedDialect = expectedDialect;
    this.journalDialect = journalDialect;
  }
}

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
  /**
   * Storage dialect of the database the migrations will be applied to.
   * When set, the journal's `dialect` field is validated against it
   * (`sqlite` ↔ `sqlite`, `postgres` ↔ `postgresql`) and a
   * {@link MigrationDialectMismatchError} is thrown on mismatch.
   *
   * Also selects the filesystem default when `migrationsDir` is omitted: the
   * default source is the bundled chain generated for this dialect, so the
   * reader can never default to a chain its own journal-dialect guard rejects.
   */
  readonly expectedDialect?: StorageDialect;
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
 *
 * When no `migrationsDir` is given, the default source is the bundled chain
 * matching `source.expectedDialect` (the SQLite chain when no dialect is
 * expected either) — the default can never be a chain the journal-dialect
 * guard below rejects.
 * @param source - Either an absolute `drizzle/` folder path or a dual-source
 *   object. Filesystem mode reads from `source.migrationsDir`, defaulting to
 *   the bundled chain for `source.expectedDialect`; bundled mode can instead
 *   use `source.migrationSourceId`.
 * @returns Ordered array of migration entries.
 * @throws If `_journal.json` or any referenced `.sql` file is missing, or a
 *   {@link MigrationDialectMismatchError} when `source.expectedDialect` does
 *   not match the journal's dialect.
 */
export function readMigrations(source: MigrationReadInput = {}): MigrationMeta[] {
  const expectedDialect = typeof source === 'string' ? undefined : source.expectedDialect;
  const migrationsDir =
    typeof source === 'string' ? source : (source.migrationsDir ?? getMigrationsFolder(expectedDialect));
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json');

  if (!existsSync(journalPath)) {
    throw new Error(`Cannot find migrations journal at ${journalPath}`);
  }

  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    dialect?: string;
    entries: Array<{ when: number; tag: string; breakpoints: boolean }>;
  };

  if (expectedDialect !== undefined && journal.dialect !== JOURNAL_DIALECTS[expectedDialect]) {
    throw new MigrationDialectMismatchError(expectedDialect, journal.dialect, journalPath);
  }

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
