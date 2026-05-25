import { createHash } from 'node:crypto';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';

/** Extension migration source supplied by the runtime coordinator. */
export interface BootExtensionMigrationSource {
  /** Package name used for diagnostics. */
  readonly name: string;
  /** Absolute path to the migration folder. */
  readonly migrationsPath: string;
  /** Stable identity for the migration bundle. */
  readonly migrationSourceId: string;
}

/**
 * Run extension-declared Drizzle migrations once per unique migration source.
 *
 * The tracking table is keyed by migration source id, not package name, so all
 * packages sharing a migration bundle use one ledger regardless of load order.
 * @param db - Runtime database handle.
 * @param sources - Migration sources in dependency order.
 */
export async function runBootExtensionMigrations(
  db: MakaioDatabase,
  sources: ReadonlyArray<BootExtensionMigrationSource>,
): Promise<void> {
  const seenSourceIds = new Set<string>();
  for (const source of sources) {
    if (seenSourceIds.has(source.migrationSourceId)) continue;
    seenSourceIds.add(source.migrationSourceId);
    const migrationsTable = buildMigrationsTableName(source.migrationSourceId);
    if (process.env['MAKAIO_DEBUG'] === 'true') {
      console.info(`[boot] Running migrations for package: ${source.name}`);
    }
    const migrations = readMigrations({
      migrationsDir: source.migrationsPath,
      migrationSourceId: source.migrationSourceId,
    });
    await applyMigrations(db, migrations, migrationsTable);
  }
}

/**
 * Build a collision-resistant Drizzle migration ledger table name from a
 * stable migration source id.
 *
 * Keyed by source id so that all packages sharing the same migration bundle
 * use one tracking table, independent of package load order and packaged host
 * filesystem layout.
 * @param migrationSourceId - Stable migration bundle identity.
 * @returns Stable migration ledger table name.
 */
function buildMigrationsTableName(migrationSourceId: string): string {
  const pathHash = createHash('sha256').update(migrationSourceId).digest('hex').slice(0, 16);
  return `__drizzle_migrations_${pathHash}`;
}
