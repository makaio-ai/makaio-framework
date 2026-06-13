/**
 * Runtime migration asset helpers.
 *
 * Drizzle source chains contain generator snapshots used for future migration
 * generation. Runtime hosts only need SQL files and `meta/_journal.json`.
 * @packageDocumentation
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RUNTIME_JOURNAL_PATH = 'meta/_journal.json';

/** Result of copying a runtime migration chain. */
export interface RuntimeMigrationChainCopyResult {
  /** Files copied into the target chain, relative to the target directory. */
  readonly copiedFiles: readonly string[];
}

interface RuntimeMigrationJournal {
  readonly entries: readonly RuntimeMigrationJournalEntry[];
}

interface RuntimeMigrationJournalEntry {
  readonly tag: string;
}

/**
 * Recursively collect files under a directory.
 * @param dir - Directory to scan.
 * @param prefix - Relative prefix accumulated during recursion.
 * @returns Slash-separated file paths relative to `dir`.
 */
function collectFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * Return whether a migration-chain file is required at runtime.
 * @param relativePath - Slash-separated path relative to a chain directory.
 * @returns Whether the file is part of the runtime migration contract.
 */
export function isRuntimeMigrationChainFile(relativePath: string): boolean {
  return relativePath === RUNTIME_JOURNAL_PATH || (!relativePath.includes('/') && relativePath.endsWith('.sql'));
}

/**
 * Return whether a directory is a Drizzle migration chain.
 * @param dir - Absolute directory path.
 * @returns Whether the directory contains a migration journal.
 */
export function isMigrationChainDirectory(dir: string): boolean {
  return existsSync(join(dir, RUNTIME_JOURNAL_PATH));
}

/**
 * Find files that should not ship in a runtime migration chain.
 * @param chainDir - Migration chain directory.
 * @returns Slash-separated unexpected file paths.
 */
export function collectUnexpectedRuntimeMigrationFiles(chainDir: string): string[] {
  if (!existsSync(chainDir)) return [];
  return collectFiles(chainDir)
    .filter((file) => !isRuntimeMigrationChainFile(file))
    .sort();
}

/**
 * Read the subset of Drizzle journal shape needed to own runtime SQL files.
 * @param journalPath - Absolute path to `meta/_journal.json`.
 * @returns Parsed journal with validated entry tags.
 */
function readRuntimeMigrationJournal(journalPath: string): RuntimeMigrationJournal {
  const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`Migration journal ${journalPath} must contain an entries array`);
  }

  const entries = parsed.entries.map((entry, index): RuntimeMigrationJournalEntry => {
    if (typeof entry !== 'object' || entry === null || !('tag' in entry) || typeof entry.tag !== 'string') {
      throw new Error(`Migration journal ${journalPath} entry #${index} must contain a string tag`);
    }
    if (entry.tag.length === 0) {
      throw new Error(`Migration journal ${journalPath} entry #${index} must contain a non-empty tag`);
    }
    return { tag: entry.tag };
  });

  const uniqueTags = new Set(entries.map((entry) => entry.tag));
  if (uniqueTags.size !== entries.length) {
    throw new Error(`Migration journal ${journalPath} contains duplicate tags`);
  }

  return { entries };
}

/**
 * Copy a Drizzle source chain into a runtime-only chain.
 *
 * The target contains exactly root-level `.sql` files and `meta/_journal.json`.
 * Source-only Drizzle snapshots, n/a markers, docs, and other notes are not
 * copied into publishable runtime artifacts.
 * @param sourceDir - Source Drizzle chain directory.
 * @param targetDir - Target runtime chain directory.
 * @returns Files copied into the target chain.
 */
export function copyRuntimeMigrationChain(sourceDir: string, targetDir: string): RuntimeMigrationChainCopyResult {
  const sourceRoot = resolve(sourceDir);
  const targetRoot = resolve(targetDir);

  if (sourceRoot === targetRoot) {
    throw new Error(`Cannot copy a migration chain onto itself: ${sourceRoot}`);
  }

  const journalPath = join(sourceRoot, RUNTIME_JOURNAL_PATH);
  if (!existsSync(journalPath)) {
    throw new Error(`Migration source ${sourceRoot} is missing ${RUNTIME_JOURNAL_PATH}`);
  }

  const sqlFiles = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  if (sqlFiles.length === 0) {
    throw new Error(`Migration source ${sourceRoot} contains no .sql migrations`);
  }

  const journal = readRuntimeMigrationJournal(journalPath);
  const journalSqlFiles = journal.entries.map((entry) => `${entry.tag}.sql`);
  const sqlFileSet = new Set(sqlFiles);
  const missingSqlFiles = journalSqlFiles.filter((file) => !sqlFileSet.has(file));
  if (missingSqlFiles.length > 0) {
    throw new Error(`Migration source ${sourceRoot} journal references missing SQL: ${missingSqlFiles.join(', ')}`);
  }

  const journalSqlFileSet = new Set(journalSqlFiles);
  const unjournaledSqlFiles = sqlFiles.filter((file) => !journalSqlFileSet.has(file));
  if (unjournaledSqlFiles.length > 0) {
    throw new Error(`Migration source ${sourceRoot} contains unjournaled SQL: ${unjournaledSqlFiles.join(', ')}`);
  }

  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(join(targetRoot, 'meta'), { recursive: true });
  cpSync(journalPath, join(targetRoot, RUNTIME_JOURNAL_PATH));

  for (const sqlFile of journalSqlFiles) {
    cpSync(join(sourceRoot, sqlFile), join(targetRoot, sqlFile));
  }

  return { copiedFiles: [...journalSqlFiles, RUNTIME_JOURNAL_PATH].sort() };
}
