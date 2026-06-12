/**
 * Central migration chain accessor for the conformance harness.
 *
 * Reads the committed migration chain for a dialect from the
 * `@makaio/storage-migrations` package so conformance suites always
 * exercise the same chain the production runtime applies.
 * @packageDocumentation
 */
import type { StorageDialect } from '@makaio/storage-drizzle';
import { getMigrationsFolder, readMigrations, type MigrationMeta } from '@makaio/storage-migrations';

/**
 * Read the central migration chain for a dialect from this workspace.
 *
 * Delegates to `readMigrations({ migrationsDir: getMigrationsFolder(dialect), expectedDialect: dialect })`
 * so the journal-dialect guard is always active — misrouting a postgres chain to an sqlite
 * runner (or vice versa) is a hard error, not a silent no-op.
 * @param dialect - Chain dialect.
 * @returns Ordered migration entries for the requested dialect.
 */
export function readCentralChain(dialect: StorageDialect): MigrationMeta[] {
  return readMigrations({ migrationsDir: getMigrationsFolder(dialect), expectedDialect: dialect });
}
