import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { MigrationMeta } from '@makaio/storage-migrations';

const IGNORED_BUILD_DIR_NAMES = new Set(['.git', '.next', '.yarn', 'coverage', 'dist', 'node_modules', 'release']);

interface JournalEntry {
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface JournalDocument {
  readonly entries: ReadonlyArray<JournalEntry>;
}

/**
 * Bundled migration source discovered at build time.
 */
export interface EmbeddedMigrationSource {
  /** Stable runtime identity used by bundled hosts. */
  readonly migrationSourceId: string;
  /** Absolute path to the source `drizzle/` directory. */
  readonly migrationsDir: string;
}

/**
 * Embedded migration bundle keyed by stable source id with known-dir aliases.
 */
export interface EmbeddedMigrations {
  /** Normalized build-time sources used to create this bundle. */
  readonly sources: ReadonlyArray<EmbeddedMigrationSource>;
  /** Migration payloads keyed by stable source id. */
  readonly migrationsBySourceId: ReadonlyMap<string, ReadonlyArray<MigrationMeta>>;
  /** Known filesystem aliases keyed by normalized absolute migrations dir. */
  readonly migrationSourceIdByDir: ReadonlyMap<string, string>;
}

function normalizeMigrationDir(migrationsDir: string): string {
  return path.resolve(migrationsDir).replace(/\\/g, '/');
}

function normalizeMigrationSourceId(migrationSourceId: string): string {
  return migrationSourceId.replace(/\\/g, '/');
}

function toPublicMigrationSourceId(relativeMigrationsDir: string): string {
  const normalized = normalizeMigrationSourceId(relativeMigrationsDir);
  const prefix = 'framework/';
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function assertJournalEntry(value: unknown, journalPath: string, index: number): JournalEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`[embedded-migrations] Invalid journal entry ${index} in ${journalPath}: expected object.`);
  }

  const candidate = value as Record<string, unknown>;
  if (!Number.isFinite(candidate.when)) {
    throw new Error(`[embedded-migrations] Invalid journal entry ${index} in ${journalPath}: "when" must be a number.`);
  }
  if (typeof candidate.tag !== 'string' || candidate.tag.length === 0) {
    throw new Error(
      `[embedded-migrations] Invalid journal entry ${index} in ${journalPath}: "tag" must be a non-empty string.`,
    );
  }
  if (typeof candidate.breakpoints !== 'boolean') {
    throw new Error(
      `[embedded-migrations] Invalid journal entry ${index} in ${journalPath}: "breakpoints" must be a boolean.`,
    );
  }

  return {
    when: candidate.when as number,
    tag: candidate.tag,
    breakpoints: candidate.breakpoints,
  };
}

function parseJournalDocument(raw: string, journalPath: string): JournalDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[embedded-migrations] Cannot parse migrations journal at ${journalPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).entries)) {
    throw new Error(`[embedded-migrations] Invalid migrations journal at ${journalPath}: expected { entries: [...] }.`);
  }

  return {
    entries: (parsed as { entries: unknown[] }).entries.map((entry, index) =>
      assertJournalEntry(entry, journalPath, index),
    ),
  };
}

function readMigrationJournal(migrationsDir: string): ReadonlyArray<JournalEntry> {
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(`[embedded-migrations] Cannot find migrations journal at ${journalPath}`);
  }

  return parseJournalDocument(readFileSync(journalPath, 'utf-8'), journalPath).entries;
}

/**
 * Build a stable bundled-host migration source id from a workspace path.
 *
 * The source id is the normalized public `drizzle/` directory so packaged hosts
 * preserve migration identity even when runtime paths collapse into `dist/` or
 * archive layouts.
 * @param workspaceRoot - Absolute workspace root.
 * @param migrationsDir - Absolute `drizzle/` directory inside the workspace.
 * @returns Stable public migration source id.
 * @throws If `migrationsDir` is outside `workspaceRoot`.
 */
export function buildMigrationSourceId(workspaceRoot: string, migrationsDir: string): string {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const normalizedMigrationsDir = path.resolve(migrationsDir);
  const relativeMigrationsDir = path.relative(normalizedWorkspaceRoot, normalizedMigrationsDir);

  if (
    relativeMigrationsDir.length === 0 ||
    relativeMigrationsDir === '..' ||
    relativeMigrationsDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeMigrationsDir)
  ) {
    throw new Error(
      `[embedded-migrations] Cannot build migrationSourceId for '${normalizedMigrationsDir}' outside workspace root '${normalizedWorkspaceRoot}'`,
    );
  }

  return toPublicMigrationSourceId(relativeMigrationsDir);
}

/**
 * Load migration SQL for each bundled migration source.
 *
 * The returned structure is keyed by stable `migrationSourceId` while also
 * tracking the original absolute `drizzle/` directory as a compatibility alias
 * for bundled callers that still pass a known source path.
 * @param migrationSources - Build-time migration sources to embed.
 * @returns Immutable embedded migration payload.
 * @throws If two sources reuse one id or directory with conflicting values.
 */
export function loadEmbeddedMigrations(migrationSources: readonly EmbeddedMigrationSource[]): EmbeddedMigrations {
  const sources: EmbeddedMigrationSource[] = [];
  const migrationsBySourceId = new Map<string, ReadonlyArray<MigrationMeta>>();
  const migrationSourceIdByDir = new Map<string, string>();
  const migrationsDirBySourceId = new Map<string, string>();

  for (const source of migrationSources) {
    const normalizedSourceId = normalizeMigrationSourceId(source.migrationSourceId);
    const normalizedMigrationsDir = normalizeMigrationDir(source.migrationsDir);
    const existingDirForSourceId = migrationsDirBySourceId.get(normalizedSourceId);
    if (existingDirForSourceId && existingDirForSourceId !== normalizedMigrationsDir) {
      throw new Error(
        `[embedded-migrations] Duplicate migrationSourceId '${normalizedSourceId}' for '${existingDirForSourceId}' and '${normalizedMigrationsDir}'`,
      );
    }

    const existingSourceIdForDir = migrationSourceIdByDir.get(normalizedMigrationsDir);
    if (existingSourceIdForDir && existingSourceIdForDir !== normalizedSourceId) {
      throw new Error(
        `[embedded-migrations] Duplicate migrationsDir '${normalizedMigrationsDir}' for '${existingSourceIdForDir}' and '${normalizedSourceId}'`,
      );
    }

    if (existingDirForSourceId || existingSourceIdForDir) {
      continue;
    }

    const migrations = readMigrationJournal(normalizedMigrationsDir).map((entry) => {
      const sqlPath = path.join(normalizedMigrationsDir, `${entry.tag}.sql`);
      if (!existsSync(sqlPath)) {
        throw new Error(
          `[embedded-migrations] Journal entry "${entry.tag}" in ${normalizedMigrationsDir} is missing SQL file ${sqlPath}`,
        );
      }

      const raw = readFileSync(sqlPath, 'utf-8');
      return {
        tag: entry.tag,
        sql: raw.split('--> statement-breakpoint'),
        folderMillis: entry.when,
        hash: createHash('sha256').update(raw).digest('hex'),
        bps: entry.breakpoints,
      } satisfies MigrationMeta;
    });

    sources.push({
      migrationSourceId: normalizedSourceId,
      migrationsDir: normalizedMigrationsDir,
    });
    migrationsBySourceId.set(normalizedSourceId, migrations);
    migrationSourceIdByDir.set(normalizedMigrationsDir, normalizedSourceId);
    migrationsDirBySourceId.set(normalizedSourceId, normalizedMigrationsDir);
  }

  return {
    sources,
    migrationsBySourceId,
    migrationSourceIdByDir,
  };
}

/**
 * Render a virtual module for bundled `readMigrations()` calls.
 *
 * The generated module preserves the dual-source runtime contract by resolving
 * `migrationSourceId` first, then falling back to known build-time directory
 * aliases for callers that still pass source `drizzle/` paths.
 * @param embeddedMigrations - Embedded bundle keyed by stable source id.
 * @param defaultMigrationSourceId - Default source id when callers omit input.
 * @returns JavaScript module source.
 * @throws If the default source id is not present in the embedded bundle.
 */
export function renderEmbeddedMigrationsModule(
  embeddedMigrations: EmbeddedMigrations,
  defaultMigrationSourceId?: string,
): string {
  const normalizedDefaultMigrationSourceId =
    defaultMigrationSourceId === undefined ? undefined : normalizeMigrationSourceId(defaultMigrationSourceId);

  if (
    normalizedDefaultMigrationSourceId !== undefined &&
    !embeddedMigrations.migrationsBySourceId.has(normalizedDefaultMigrationSourceId)
  ) {
    throw new Error(
      `[embedded-migrations] Bundled build has no embedded migrations for default migrationSourceId '${normalizedDefaultMigrationSourceId}'`,
    );
  }

  const serializedMigrationsBySourceId = JSON.stringify([...embeddedMigrations.migrationsBySourceId.entries()]);
  const serializedMigrationSourceIdByDir = JSON.stringify([...embeddedMigrations.migrationSourceIdByDir.entries()]);
  const serializedDefaultMigrationSourceId =
    normalizedDefaultMigrationSourceId === undefined ? 'undefined' : JSON.stringify(normalizedDefaultMigrationSourceId);

  return [
    `import path from 'node:path';`,
    `const MIGRATIONS_BY_SOURCE_ID = new Map(${serializedMigrationsBySourceId});`,
    `const MIGRATION_SOURCE_ID_BY_DIR = new Map(${serializedMigrationSourceIdByDir});`,
    `const DEFAULT_MIGRATION_SOURCE_ID = ${serializedDefaultMigrationSourceId};`,
    `function normalizeMigrationsDir(migrationsDir) {`,
    `  return path.resolve(String(migrationsDir)).replace(/\\\\/g, '/');`,
    `}`,
    `function normalizeMigrationSourceId(migrationSourceId) {`,
    `  return String(migrationSourceId).replace(/\\\\/g, '/');`,
    `}`,
    `function cloneMigrations(migrations) {`,
    `  return migrations.map((migration) => ({ ...migration, sql: [...migration.sql] }));`,
    `}`,
    `function resolveMigrationSourceId(source) {`,
    `  if (source === undefined) {`,
    `    return DEFAULT_MIGRATION_SOURCE_ID;`,
    `  }`,
    `  if (typeof source === 'string') {`,
    `    const normalizedSourceId = normalizeMigrationSourceId(source);`,
    `    if (MIGRATIONS_BY_SOURCE_ID.has(normalizedSourceId)) {`,
    `      return normalizedSourceId;`,
    `    }`,
    `    const normalizedSource = normalizeMigrationsDir(source);`,
    `    return MIGRATION_SOURCE_ID_BY_DIR.get(normalizedSource) ?? normalizedSource;`,
    `  }`,
    `  if (source && typeof source === 'object') {`,
    `    if (source.migrationSourceId !== undefined) {`,
    `      return normalizeMigrationSourceId(source.migrationSourceId);`,
    `    }`,
    `    if (source.migrationsDir !== undefined) {`,
    `      const normalizedDir = normalizeMigrationsDir(source.migrationsDir);`,
    `      return MIGRATION_SOURCE_ID_BY_DIR.get(normalizedDir) ?? normalizedDir;`,
    `    }`,
    `  }`,
    `  return DEFAULT_MIGRATION_SOURCE_ID;`,
    `}`,
    `export function readMigrations(source) {`,
    `  const migrationSourceId = resolveMigrationSourceId(source);`,
    `  if (migrationSourceId === undefined) {`,
    `    throw new Error('Bundled builds require an embedded migrations directory or migrationSourceId.');`,
    `  }`,
    `  const migrations = MIGRATIONS_BY_SOURCE_ID.get(migrationSourceId);`,
    `  if (!migrations) {`,
    `    throw new Error('[embedded-migrations] Bundled build has no embedded migrations for ' + migrationSourceId);`,
    `  }`,
    `  return cloneMigrations(migrations);`,
    `}`,
    `export function getMigrationsFolder() {`,
    `  throw new Error('getMigrationsFolder() is not available in bundled builds. Use readMigrations({ migrationSourceId }) or readMigrations(migrationsDir) instead.');`,
    `}`,
  ].join('\n');
}

/**
 * Discover migration sources that should be embedded into bundled hosts.
 *
 * Scans the workspace for `drizzle/meta/_journal.json` files while excluding
 * generated build trees such as `dist/` and `release/`.
 *
 * Only directories literally named `drizzle` are embedded. Packaged hosts are
 * SQLite-only, and the SQLite migration chain always lives in a `drizzle/`
 * directory, so this is exactly the chain a bundled host needs. An extension
 * that also ships a Postgres chain must emit it into a differently named
 * directory (by convention `drizzle-postgres`, matching the central chain) so
 * the Postgres chain is never swept into a SQLite-only embedded host. This
 * function performs no dialect validation; the non-`drizzle` directory name is
 * the guard.
 * @param workspaceRoot - Absolute workspace root.
 * @returns Sorted unique migration sources.
 */
export function discoverBundledMigrationSources(workspaceRoot: string): EmbeddedMigrationSource[] {
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  const discovered = new Set<string>();
  const stack = [normalizedWorkspaceRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      console.warn(
        `[embedded-migrations] Skipping unreadable directory during discovery: ${current}`,
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (IGNORED_BUILD_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      // Embed only `drizzle/` chains: packaged hosts are SQLite-only and the
      // SQLite chain always lives here. A Postgres chain must use a non-`drizzle`
      // directory (convention: `drizzle-postgres`) so it stays out of this sweep.
      if (entry.name === 'drizzle' && existsSync(path.join(fullPath, 'meta', '_journal.json'))) {
        discovered.add(normalizeMigrationDir(fullPath));
        continue;
      }

      stack.push(fullPath);
    }
  }

  return [...discovered]
    .sort((left, right) => left.localeCompare(right))
    .map((migrationsDir) => ({
      migrationSourceId: buildMigrationSourceId(normalizedWorkspaceRoot, migrationsDir),
      migrationsDir,
    }));
}

/**
 * Discover bundled migration directories without source metadata.
 *
 * Kept as a narrow compatibility shim while call sites migrate to
 * `discoverBundledMigrationSources()`.
 * @param workspaceRoot - Absolute workspace root.
 * @returns Sorted unique `drizzle/` directories.
 */
export function discoverBundledMigrationDirs(workspaceRoot: string): string[] {
  return discoverBundledMigrationSources(workspaceRoot).map((source) => source.migrationsDir);
}
