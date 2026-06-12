/**
 * Resolve the bundled Drizzle migrations directory for a given storage dialect.
 *
 * Used by {@link initializeNodeDatabase} as the automatic fallback migrations
 * source for URL-backed (Postgres) targets when no explicit `migrationsDir` is
 * provided. The two-probe strategy covers both the published package layout
 * (built dist/) and a source-checkout layout where `@makaio/storage-migrations`
 * is available as a workspace package.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getMigrationsFolder } from '@makaio/storage-migrations';
import type { StorageDialect } from '@makaio/storage-drizzle';

/**
 * Returns `true` when the given directory contains a valid Drizzle migration
 * journal at the expected path.
 *
 * A valid candidate must have `meta/_journal.json` present; this matches the
 * layout drizzle-kit generates and is the minimum needed for `readMigrations`
 * to succeed.
 * @param dir - Absolute path of the candidate migrations directory.
 * @returns Whether the directory contains `meta/_journal.json`.
 */
function hasJournal(dir: string): boolean {
  return existsSync(path.join(dir, 'meta', '_journal.json'));
}

/**
 * Environment-dependent probe inputs for {@link resolveBundledMigrationsDir}.
 *
 * Production callers omit this and resolve against the real environment: this
 * module's directory for the built-layout probe and `getMigrationsFolder` from
 * `@makaio/storage-migrations` for the source-checkout probe. Tests inject
 * controlled values to pin both probe outcomes against on-disk fixtures
 * without module-level mocking.
 */
export interface BundledMigrationsProbes {
  /**
   * Base directory of the built-layout probe; the candidate is
   * `<moduleDir>/../drizzle[-postgres]`. Defaults to this module's directory.
   */
  readonly moduleDir?: string;
  /**
   * Source-checkout probe returning the workspace migration chain for a
   * dialect. Defaults to `getMigrationsFolder` from
   * `@makaio/storage-migrations`; bundled hosts replace that implementation
   * with a stub that throws.
   */
  readonly getMigrationsFolder?: (dialect: StorageDialect) => string;
}

/**
 * Resolve the bundled Drizzle migrations directory for a dialect.
 *
 * Probe order:
 * 1. `path.resolve(moduleDir, '..', dialect === 'postgres' ? 'drizzle-postgres' : 'drizzle')`
 *    — the published package layout, where this module is built into
 *    `dist/runtime-node` and the migration chains are copied alongside.
 * 2. `getMigrationsFolder(dialect)` from `@makaio/storage-migrations`, wrapped
 *    in try/catch — bundled hosts replace the module with a stub that throws;
 *    treat a throw as a failed probe and carry its message into the final error.
 *
 * A candidate is valid iff `<candidate>/meta/_journal.json` exists. Returns the
 * first valid candidate.
 *
 * Pass an explicit `migrationsDir` (boot option `centralMigrationsDir` or
 * `InitializeNodeDatabaseOptions.migrationsDir`) when the migrations directory
 * is staged elsewhere.
 *
 * When neither probe yields the requested dialect's chain, resolution fails
 * loudly rather than silently falling back to the other dialect's chain.
 * @param dialect - Storage dialect whose migration chain to locate.
 * @param probes - Optional probe overrides; production callers omit this.
 * @returns Absolute path of the migrations directory for the given dialect.
 * @throws Error listing every probed path, the `meta/_journal.json` requirement,
 *   and the explicit override remedy (`centralMigrationsDir`).
 */
export function resolveBundledMigrationsDir(dialect: StorageDialect, probes: BundledMigrationsProbes = {}): string {
  const { moduleDir = import.meta.dirname, getMigrationsFolder: probeSourceChain = getMigrationsFolder } = probes;
  const chainDirName = dialect === 'postgres' ? 'drizzle-postgres' : 'drizzle';
  const probeNotes: string[] = [];

  // Probe 1 — built package layout: this module ships inside dist/runtime-node,
  // so the chain copied next to it resolves as ../drizzle[-postgres].
  const bundledCandidate = path.resolve(moduleDir, '..', chainDirName);
  if (hasJournal(bundledCandidate)) return bundledCandidate;
  probeNotes.push(bundledCandidate);

  // Probe 2 — source-checkout chain. Bundled hosts replace getMigrationsFolder
  // with a stub that throws; treat that as a failed probe, not a crash.
  try {
    const sourceCandidate = probeSourceChain(dialect);
    if (hasJournal(sourceCandidate)) return sourceCandidate;
    probeNotes.push(sourceCandidate);
  } catch (error) {
    probeNotes.push(
      `getMigrationsFolder('${dialect}') unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  throw new Error(
    `resolveBundledMigrationsDir: no '${dialect}' migrations directory with meta/_journal.json found. ` +
      `Probed: ${probeNotes.join('; ')}. Pass an explicit migrations directory ` +
      `(boot option 'centralMigrationsDir' or InitializeNodeDatabaseOptions.migrationsDir) ` +
      `when migrations are staged elsewhere.`,
  );
}
