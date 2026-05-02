/**
 * Migration runtime utilities.
 *
 * Provides path resolution for Drizzle migration files at application startup.
 */
import path from 'node:path';

/**
 * Resolve the drizzle migrations folder path.
 *
 * Used by NodeRuntime to locate SQL migration files at startup.
 * The drizzle/ folder is co-located with src/ in this package.
 * @returns Absolute path to the drizzle migrations folder
 */
export function getMigrationsFolder(): string {
  return path.resolve(import.meta.dirname, '../drizzle');
}
