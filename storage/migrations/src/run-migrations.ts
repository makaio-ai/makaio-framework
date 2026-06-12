/**
 * Migration runtime utilities.
 *
 * Provides path resolution for Drizzle migration files at application startup.
 */
import path from 'node:path';
import { getStorageEngine, type StorageDialect } from '@makaio/storage-drizzle';

/**
 * Resolve the package-local drizzle migrations folder for a dialect.
 *
 * Used by NodeRuntime to locate SQL migration files at startup. The chain
 * directory name is owned by the dialect's engine
 * (`StorageEngine.migrations.chainDirName`); the package-local default —
 * the named folder co-located with `src/` in this package — covers the
 * SQLite chain (`drizzle/`). Engines whose chain ships in their own package
 * (such as `@makaio/storage-pg`) implement `resolveSourceChainDir()`, and
 * that absolute path wins over the package-local default.
 *
 * In bundled hosts the esbuild plugin replaces this entire module with a stub
 * that throws — the zero-arg default keeps existing call sites compiling without
 * change and the extra `dialect` argument is harmless on a stub that throws
 * regardless.
 * @param dialect - Storage dialect whose chain to locate. Defaults to `'sqlite'`.
 * @returns Absolute path to the drizzle migrations folder for the requested dialect.
 */
export function getMigrationsFolder(dialect: StorageDialect = 'sqlite'): string {
  const { migrations } = getStorageEngine(dialect);
  return migrations.resolveSourceChainDir?.() ?? path.resolve(import.meta.dirname, '..', migrations.chainDirName);
}
