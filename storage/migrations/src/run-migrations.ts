/**
 * Migration runtime utilities.
 *
 * Provides path resolution for Drizzle migration files at application startup.
 */
import path from 'node:path';
import type { StorageDialect } from '@makaio/storage-drizzle';

/**
 * Resolve the package-local drizzle migrations folder for a dialect.
 *
 * Used by NodeRuntime to locate SQL migration files at startup.
 * The `drizzle/` folder (SQLite) and `drizzle-postgres/` folder (Postgres) are
 * co-located with `src/` in this package.
 *
 * In bundled hosts the esbuild plugin replaces this entire module with a stub
 * that throws — the zero-arg default keeps existing call sites compiling without
 * change and the extra `dialect` argument is harmless on a stub that throws
 * regardless.
 * @param dialect - Storage dialect whose chain to locate. Defaults to `'sqlite'`.
 * @returns Absolute path to the drizzle migrations folder for the requested dialect.
 */
export function getMigrationsFolder(dialect: StorageDialect = 'sqlite'): string {
  return path.resolve(import.meta.dirname, dialect === 'postgres' ? '../drizzle-postgres' : '../drizzle');
}
