/**
 * \@makaio/storage-migrations
 *
 * Centralized Drizzle migration management for the Makaio workspace.
 *
 * ## Runtime API
 * - getMigrationsFolder() - Path to SQL migration files for NodeRuntime
 * - readMigrations() - Reads migration entries from the co-located drizzle/ folder
 * - applyMigrations() - Applies pre-resolved migrations to a libsql database
 *
 * ## Dev-time CLI
 * - discover-schemas.ts - Scans workspace for makaio.drizzleSchema declarations
 * - generate-schema.ts - Generates aggregated .generated/schema.ts
 *
 * ## Workflow
 * 1. Packages declare schema files via makaio.drizzleSchema in package.json
 * 2. Run yarn workspace \@makaio/storage-migrations db:generate
 * 3. Review generated SQL in ./drizzle/
 * 4. Migrations auto-apply on startup via NodeRuntime
 */

export { getMigrationsFolder } from './run-migrations.js';
export { discoverSchemas } from './discover-schemas.js';
export { generateSchema } from './generate-schema.js';
export type { GenerateSchemaOptions } from './generate-schema.js';
export type { DiscoveredSchema } from './discover-schemas.js';
export {
  readMigrations,
  type MigrationMeta,
  type MigrationReadInput,
  type MigrationReadSource,
} from './read-migrations.js';
export { applyMigrations } from './apply-migrations.js';
