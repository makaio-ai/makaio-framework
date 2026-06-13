/**
 * CLI entry point for generating aggregated Drizzle schema.
 *
 * Discovers all schema files from workspace packages and generates consolidated
 * barrel files in `.generated/` that Drizzle Kit uses to produce SQL migration
 * files.
 *
 * - `schema.ts` — SQLite (baseline) dialect barrel (always generated)
 * - `schema.postgres.ts` — Postgres dialect barrel
 *
 * When run as the CLI entrypoint, the barrels generated are selected by which
 * engine packages are present: the SQLite baseline barrel is always emitted,
 * and each non-baseline dialect barrel (e.g. Postgres) is emitted only when its
 * engine package resolves. A checkout without the Postgres engine therefore
 * generates the SQLite barrel alone and never feeds a stale `schema.postgres.ts`
 * to a drizzle-kit config that is absent. `generateSchema` itself still honours
 * an explicit `options.dialects` list unchanged — only the entrypoint's dialect
 * selection is engine-driven.
 *
 * Usage: tsx src/generate-schema.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { NON_BASELINE_GENERATION_LEGS, type StorageDialect } from '@makaio/storage-drizzle';
import { discoverSchemas } from './discover-schemas.js';

/** Barrel file name for each storage dialect. */
const BARREL_FILE_NAME: Readonly<Record<StorageDialect, string>> = {
  sqlite: 'schema.ts',
  postgres: 'schema.postgres.ts',
};

export interface GenerateSchemaOptions {
  /** Absolute path to the workspace root directory */
  workspaceRoot?: string;
  /** Absolute path to the .generated directory */
  generatedDir?: string;
  /** Optional logger for status output */
  logger?: Pick<typeof console, 'info'>;
  /**
   * Override workspace glob patterns for schema discovery. When provided, these
   * patterns are used instead of the patterns from the root package.json workspaces field.
   */
  patterns?: string[];
  /**
   * Dialects to emit aggregated barrels for. Defaults to `['sqlite']` —
   * SQLite is the baseline dialect; additional dialects are opt-in per runner.
   * When provided, the list must contain at least one dialect: an empty list
   * is rejected because it would write no barrels and leave any previously
   * generated schema in place, silently feeding stale schema to Drizzle Kit.
   * Barrel file names: `'sqlite'` → `schema.ts`, `'postgres'` → `schema.postgres.ts`.
   */
  dialects?: readonly StorageDialect[];
}

/**
 * Generate aggregated schema barrel files from discovered workspace schemas.
 *
 * For each requested dialect:
 * 1. Runs `discoverSchemas` for that dialect to collect declared schema paths.
 * 2. Creates `.generated/` if it does not exist.
 * 3. Writes the dialect barrel with `export * from '<absolute posix path>';` lines.
 * 4. Logs discovered schemas for visibility.
 * @param options - Generation options
 * @returns Promise that resolves once all barrels are written
 * @throws Error when `options.dialects` is provided but empty
 */
export async function generateSchema(options: GenerateSchemaOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  // Workspace root is 3 levels up from src/: src -> migrations -> storage -> repository root.
  const workspaceRoot = options.workspaceRoot ?? path.resolve(import.meta.dirname, '../../..');
  if (options.dialects && options.dialects.length === 0) {
    throw new Error(
      'generateSchema: options.dialects must contain at least one dialect when provided — ' +
        'an empty list would write no barrels and leave stale generated schema in place.',
    );
  }
  const dialects: readonly StorageDialect[] = options.dialects ?? ['sqlite'];

  logger.info(`Workspace root: ${workspaceRoot}`);

  // Create .generated directory once, before any dialect writes.
  const generatedDir = options.generatedDir ?? path.resolve(import.meta.dirname, '../.generated');
  fs.mkdirSync(generatedDir, { recursive: true });

  for (const dialect of dialects) {
    const schemas = await discoverSchemas(workspaceRoot, options.patterns, dialect);
    logger.info(`\nDiscovered ${schemas.length} ${dialect} schema(s):`);

    for (const schema of schemas) {
      logger.info(`  - ${schema.packageName}`);
      logger.info(`    ${schema.schemaPath}`);
    }

    // Generate the barrel with export statements.
    // Use forward slashes for cross-platform compatibility.
    const barrelContent = schemas
      .map((schema) => {
        const normalizedPath = schema.schemaPath.replace(/\\/g, '/');
        return `export * from '${normalizedPath}';`;
      })
      .join('\n');

    const barrelFileName = BARREL_FILE_NAME[dialect];
    const barrelPath = path.join(generatedDir, barrelFileName);
    fs.writeFileSync(barrelPath, barrelContent + '\n', 'utf-8');

    logger.info(`\n✓ Generated: ${barrelPath}`);
  }
}

/**
 * Determine whether this file is being executed directly.
 *
 * Kept local to this CLI entrypoint so the generation contract stays
 * independent of shared runtime helpers.
 * @returns True when invoked as the entrypoint via tsx/node
 */
function isMainModule(): boolean {
  if (typeof import.meta.main === 'boolean') {
    return import.meta.main;
  }
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(entry).href === import.meta.url;
}

/**
 * Resolve the dialects whose barrels the CLI entrypoint should generate.
 *
 * Starts from the SQLite baseline, then appends each non-baseline dialect whose
 * engine package is installed in this workspace. Presence is probed by resolving
 * the engine's `package.json`: a `MODULE_NOT_FOUND` rejection means the engine is
 * absent and its barrel is skipped, so a framework-only checkout generates the
 * SQLite barrel alone. Any other resolution error is rethrown.
 * @returns Baseline plus every present non-baseline dialect, in descriptor order.
 */
export function resolvePresentDialects(): StorageDialect[] {
  const require = createRequire(import.meta.url);
  const dialects: StorageDialect[] = ['sqlite'];
  for (const leg of NON_BASELINE_GENERATION_LEGS) {
    try {
      require.resolve(`${leg.enginePackageName}/package.json`);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        continue;
      }
      throw err;
    }
    dialects.push(leg.dialect);
  }
  return dialects;
}

// Run if executed directly — generate the baseline barrel plus a barrel for each
// present non-baseline engine, so absent engines never receive a stale barrel.
if (isMainModule()) {
  void generateSchema({ dialects: resolvePresentDialects() });
}
