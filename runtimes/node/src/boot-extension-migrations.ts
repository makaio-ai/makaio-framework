import { createHash } from 'node:crypto';
import { getDatabaseDialect, type MakaioDatabase, type StorageDialect } from '@makaio/storage-drizzle';
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
  /**
   * Optional per-dialect migration chains, mirroring the manifest
   * `drizzleSchema` object form. When the entry for the active dialect is
   * present it overrides `migrationsPath`; otherwise the runner falls back to
   * `migrationsPath`.
   */
  readonly migrationsPathByDialect?: Partial<Record<StorageDialect, string>>;
}

/**
 * Run extension-declared Drizzle migrations once per unique migration source.
 *
 * The tracking table is keyed by migration source id, not package name, so all
 * packages sharing a migration bundle use one ledger regardless of load order.
 *
 * On a dialect mismatch the failure names the extension and the remedy
 * (disable on that dialect's hosts, or ship a migration chain generated for
 * that dialect), and boot fails loudly by design — silently skipping would
 * let extensions register handlers against absent tables.
 * @param db - Runtime database handle.
 * @param sources - Migration sources in dependency order.
 */
export async function runBootExtensionMigrations(
  db: MakaioDatabase,
  sources: ReadonlyArray<BootExtensionMigrationSource>,
): Promise<void> {
  // Derived from the handle so the extension tier gets the same always-on
  // journal-dialect guard as the central tier in runMigrations.
  const expectedDialect = getDatabaseDialect(db);
  const seenSourceIds = new Set<string>();
  for (const source of sources) {
    if (seenSourceIds.has(source.migrationSourceId)) continue;
    seenSourceIds.add(source.migrationSourceId);
    const migrationsTable = buildMigrationsTableName(source.migrationSourceId);
    if (process.env['MAKAIO_DEBUG'] === 'true') {
      console.info(`[boot] Running migrations for package: ${source.name}`);
    }
    let migrations;
    try {
      migrations = readMigrations({
        migrationsDir: source.migrationsPathByDialect?.[expectedDialect] ?? source.migrationsPath,
        migrationSourceId: source.migrationSourceId,
        expectedDialect,
      });
    } catch (error) {
      // Matched by name: bundled builds load a separate copy of the migrations
      // package, so class identity cannot be relied on across that boundary.
      if (error instanceof Error && error.name === 'MigrationDialectMismatchError') {
        throw new Error(
          `Extension '${source.name}' ships migrations that do not match the '${expectedDialect}' database dialect. ` +
            `Disable this extension on '${expectedDialect}' hosts or ship a migration chain generated for '${expectedDialect}'.`,
          { cause: error },
        );
      }
      throw error;
    }
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
 *
 * Note: the `__drizzle_migrations_<hash>` prefix is the established SQLite
 * ledger naming convention and must not be renamed — installed databases
 * depend on it. Extension ledgers currently use this name on every dialect;
 * the `__makaio_migrations_<hash>` naming stays reserved for a future
 * dedicated Postgres extension ledger format.
 * @param migrationSourceId - Stable migration bundle identity.
 * @returns Stable migration ledger table name.
 */
function buildMigrationsTableName(migrationSourceId: string): string {
  const pathHash = createHash('sha256').update(migrationSourceId).digest('hex').slice(0, 16);
  return `__drizzle_migrations_${pathHash}`;
}
