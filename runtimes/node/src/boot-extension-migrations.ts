import { createHash } from 'node:crypto';
import {
  resolveStorageEngine,
  type MakaioDatabase,
  type StorageDialect,
  type StorageEngine,
} from '@makaio/storage-drizzle';
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
   * Optional per-dialect migration chains, mirroring the extension
   * `storage.migrations` object form (an extension-tier declaration, distinct
   * from the central-tier `makaio.drizzleSchema`). `storage.migrations` is the
   * extension's own migration chain applied to the extension tier, whereas
   * `makaio.drizzleSchema` contributes schema to the central framework chain —
   * two independent mechanisms, neither a subset of the other. When the entry
   * for the active dialect is present it overrides `migrationsPath`; otherwise
   * the runner falls back to `migrationsPath`.
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
  // Resolved from the handle so the extension tier gets the same always-on
  // journal-dialect guard as the central tier in runMigrations, and so the
  // engine owns the extension ledger naming scheme.
  const engine = resolveStorageEngine(db);
  const expectedDialect = engine.dialect;
  const seenSourceIds = new Set<string>();
  for (const source of sources) {
    if (seenSourceIds.has(source.migrationSourceId)) continue;
    seenSourceIds.add(source.migrationSourceId);
    const migrationsTable = buildMigrationsTableName(source.migrationSourceId, engine);
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
 * filesystem layout. The naming scheme is owned by the engine
 * (`StorageEngine.migrations.extensionLedgerName`): SQLite keeps the
 * installed-base `__drizzle_migrations_<sha256-16>` convention, which must
 * never change — installed databases depend on it. The Postgres engine names
 * extension ledgers `__makaio_migrations_<sha256-16>` (adopted with the
 * engine seam — no installed Postgres extension ledgers can predate it,
 * because Postgres hosts hard-fail SQLite extension chains at the
 * journal-dialect guard before any ledger DDL runs).
 * @param migrationSourceId - Stable migration bundle identity.
 * @param engine - Engine serving the target database; owns the naming scheme.
 * @returns Stable migration ledger table name.
 */
function buildMigrationsTableName(migrationSourceId: string, engine: StorageEngine): string {
  const sourceHash = createHash('sha256').update(migrationSourceId).digest('hex').slice(0, 16);
  return engine.migrations.extensionLedgerName(sourceHash);
}
