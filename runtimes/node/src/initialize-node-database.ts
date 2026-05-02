import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabaseClient, type DatabaseClient } from '@makaio/storage-drizzle/client';
import { runMigrations } from './db-migrations.js';

/**
 * Options for {@link initializeNodeDatabase}.
 */
export interface InitializeNodeDatabaseOptions {
  /** Override database file path. Defaults to MAKAIO_DATABASE_PATH env var, then `<makaioHome>/makaio.db`. */
  dbPath?: string;
  /**
   * Makaio home directory used to derive the default database path.
   * Superseded by `dbPath` and `MAKAIO_DATABASE_PATH`.
   */
  makaioHome: string;
}

/**
 * Result returned by {@link initializeNodeDatabase}.
 */
export interface InitializeNodeDatabaseResult {
  databaseClient: DatabaseClient;
  dbPath: string;
}

/**
 * Determine whether a chmod failure is expected for this runtime.
 * @param error - Error thrown by fs.promises.chmod
 * @returns True when the failure can be safely ignored.
 */
function shouldIgnoreChmodError(error: unknown): boolean {
  if (process.platform === 'win32') {
    // Windows does not reliably apply POSIX file mode semantics.
    return true;
  }

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // Some filesystems/platforms do not support chmod semantics.
  return code === 'ENOSYS' || code === 'EINVAL';
}

/**
 * Initialize SQLite database for Node runtime persistence.
 *
 * Supports `MAKAIO_DATABASE_PATH` for test or custom environments.
 * When `options.dbPath` is provided it takes precedence over the environment
 * variable, avoiding the need for callers to mutate `process.env`.
 * @param options - Configuration; see {@link InitializeNodeDatabaseOptions}.
 * @returns Initialized database client and resolved database path.
 */
export async function initializeNodeDatabase(
  options: InitializeNodeDatabaseOptions,
): Promise<InitializeNodeDatabaseResult> {
  const dbPath = options.dbPath ?? process.env.MAKAIO_DATABASE_PATH ?? path.join(options.makaioHome, 'makaio.db');

  // Ensure parent directory exists (for both default and custom paths)
  const dbDir = path.dirname(dbPath);
  await fs.promises.mkdir(dbDir, { recursive: true });

  const databaseClient = await createDatabaseClient({ url: pathToFileURL(dbPath).href });
  try {
    await runMigrations(databaseClient.db);
    // Best-effort hardening: some platforms/filesystems may not support POSIX modes.
    try {
      await fs.promises.chmod(dbPath, 0o600);
    } catch (error) {
      if (!shouldIgnoreChmodError(error)) {
        throw error;
      }
      console.warn(
        '[initializeNodeDatabase] Failed to set SQLite file permissions (continuing; this may be unsupported on Windows):',
        error,
      );
    }
    return { databaseClient, dbPath };
  } catch (error) {
    databaseClient.close();
    throw error;
  }
}
