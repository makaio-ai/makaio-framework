/**
 * \@makaio/storage-migrations
 *
 * Centralized Drizzle migration management for the Makaio workspace.
 *
 * ## Runtime API (this barrel)
 * - getMigrationsFolder() - Path to SQL migration files for NodeRuntime
 * - readMigrations() - Reads migration entries from the co-located drizzle/ folder
 * - applyMigrations() - Applies pre-resolved migrations through the dialect-portable raw SQL executor
 *
 * ## Dev-time CLI
 * - discover-schemas.ts - Scans workspace for makaio.drizzleSchema declarations (source-local helper)
 * - `@makaio/storage-migrations/generate-schema` - Generates aggregated .generated/schema.ts
 * - `@makaio/storage-migrations/generate-migrations` - One-command chain generator for every present dialect
 */

export { getMigrationsFolder } from './run-migrations.js';
export {
  MigrationDialectMismatchError,
  readMigrations,
  type MigrationMeta,
  type MigrationReadInput,
  type MigrationReadSource,
} from './read-migrations.js';
export { applyMigrations } from './apply-migrations.js';
