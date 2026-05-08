/**
 * CLI entry point for generating aggregated Drizzle schema.
 *
 * Discovers all schema files from workspace packages and generates a consolidated
 * .generated/schema.ts file that re-exports all schemas. This is used by drizzle-kit
 * for migration generation.
 *
 * Usage: tsx src/generate-schema.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverSchemas } from './discover-schemas.js';

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
}

/**
 * Generate aggregated schema file from discovered workspace schemas.
 *
 * 1. Determines workspace root (defaults to 3 levels up from src/)
 * 2. Discovers all schemas via makaio.drizzleSchema declarations
 * 3. Creates .generated/ directory if needed
 * 4. Writes .generated/schema.ts with export statements
 * 5. Logs discovered schemas for visibility
 * @param options - Generation options
 * @returns Promise that resolves once the schema is written
 */
export async function generateSchema(options: GenerateSchemaOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  // Workspace root is 3 levels up from src/: src -> storage-migrations -> packages -> framework.
  // This resolves to the framework distribution root (framework/package.json).
  const workspaceRoot = options.workspaceRoot ?? path.resolve(import.meta.dirname, '../../..');
  logger.info(`Workspace root: ${workspaceRoot}`);

  // Discover schemas
  const schemas = await discoverSchemas(workspaceRoot, options.patterns);
  logger.info(`\nDiscovered ${schemas.length} schema(s):`);

  for (const schema of schemas) {
    logger.info(`  - ${schema.packageName}`);
    logger.info(`    ${schema.schemaPath}`);
  }

  // Create .generated directory
  const generatedDir = options.generatedDir ?? path.resolve(import.meta.dirname, '../.generated');
  fs.mkdirSync(generatedDir, { recursive: true });

  // Generate schema.ts with export statements
  // Use forward slashes for cross-platform compatibility
  const schemaContent = schemas
    .map((schema) => {
      const normalizedPath = schema.schemaPath.replace(/\\/g, '/');
      return `export * from '${normalizedPath}';`;
    })
    .join('\n');

  const schemaPath = path.join(generatedDir, 'schema.ts');
  fs.writeFileSync(schemaPath, schemaContent + '\n', 'utf-8');

  logger.info(`\n✓ Generated: ${schemaPath}`);
}

/**
 * Determine whether this file is being executed directly.
 *
 * Kept local to this CLI entrypoint rather than promoted to `@makaio/utils`:
 * sharing it would add a package dependency for two generator call sites
 * without changing the schema generation contract.
 * @returns True when invoked as the entrypoint via tsx/node
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(entry).href === import.meta.url;
}

// Run if executed directly
if (isMainModule()) {
  void generateSchema();
}
