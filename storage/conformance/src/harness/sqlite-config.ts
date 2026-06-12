/**
 * SQLite dialect implementation of the conformance config.
 *
 * Provisions a fresh temp-file SQLite database per suite and applies the
 * central SQLite migration chain before returning the context.
 * @packageDocumentation
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { applyMigrations } from '@makaio/storage-migrations';
import type {
  CreateDatabaseContextOptions,
  SiblingClient,
  SiblingClientOptions,
  StorageConformanceCapabilities,
  StorageConformanceConfig,
  StorageDatabaseContext,
} from './config.js';
import { readCentralChain } from './chains.js';
import { collectRejections, rethrowCleanupFailures } from './cleanup-failures.js';

/** Capability flags for the SQLite dialect. */
const SQLITE_CAPABILITIES: StorageConformanceCapabilities = {
  fts: true,
};

/**
 * Remove the temp database file and its WAL/SHM companions.
 *
 * ENOENT is the only swallowed error (missing companions are normal); any
 * other unlink failure throws for loud leak detection.
 * @param dbPath - Absolute path to the temp database file.
 */
function unlinkDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

/**
 * Create a fresh SQLite conformance context backed by a temp-file database.
 * @param dbPath - Absolute path to the temp database file.
 * @param options - Provisioning options.
 * @returns Initialized database context.
 */
async function createSqliteDatabaseContext(
  dbPath: string,
  options: CreateDatabaseContextOptions,
): Promise<StorageDatabaseContext> {
  const fileUrl = `file:${dbPath}`;
  const primary = await createDatabaseClient({ url: fileUrl });
  const executor = getRawSqlExecutor(primary.db);

  if (options.applyCentralChain !== false) {
    try {
      await applyMigrations(primary.db, readCentralChain('sqlite'));
    } catch (error) {
      // Provisioning failed before the context (and its cleanup contract)
      // reached the caller: release the resources here. Both steps are
      // best-effort — their own failures must not mask the migration error.
      try {
        await primary.close();
      } catch {
        // Best-effort only.
      }
      try {
        unlinkDatabaseFiles(dbPath);
      } catch {
        // Best-effort only.
      }
      throw error;
    }
  }

  const siblings: SiblingClient[] = [];

  const createSiblingClient = async (_siblingOptions?: SiblingClientOptions): Promise<SiblingClient> => {
    // SQLite: second client on the same temp file URL.
    // poolMax and postgresSettings are postgres-only and ignored here.
    const siblingClient = await createDatabaseClient({ url: fileUrl });
    const siblingExecutor = getRawSqlExecutor(siblingClient.db);

    let closed = false;
    const sibling: SiblingClient = {
      db: siblingClient.db,
      executor: siblingExecutor,
      close: async () => {
        if (closed) return;
        closed = true;
        await siblingClient.close();
      },
    };
    siblings.push(sibling);
    return sibling;
  };

  const cleanup = async (): Promise<void> => {
    // Every resource the context owns gets a release attempt: failures are
    // collected instead of aborting teardown, so one failing close can never
    // skip the file removal. Collected failures are rethrown once teardown
    // has reached the end (loud leak detection).
    const failures: unknown[] = [];

    // Close all tracked siblings (independent connections, closed concurrently).
    collectRejections(failures, await Promise.allSettled(siblings.map((sibling) => sibling.close())));

    // Close primary.
    try {
      await primary.close();
    } catch (error) {
      failures.push(error);
    }

    // Unlink db file, WAL, and SHM — ENOENT is swallowed inside the helper.
    try {
      unlinkDatabaseFiles(dbPath);
    } catch (error) {
      failures.push(error);
    }

    rethrowCleanupFailures(failures, `SQLite conformance cleanup for '${dbPath}' failed; resources may have leaked`);
  };

  return {
    db: primary.db,
    dialect: 'sqlite',
    capabilities: SQLITE_CAPABILITIES,
    executor,
    createSiblingClient,
    cleanup,
  };
}

/**
 * Build a SQLite conformance config.
 *
 * Each call to {@link StorageConformanceConfig.createDatabaseContext} provisions
 * a fresh isolated temp-file SQLite database.
 * @returns SQLite conformance config.
 */
export function createSqliteConfig(): StorageConformanceConfig {
  return {
    name: 'sqlite',
    dialect: 'sqlite',
    capabilities: SQLITE_CAPABILITIES,
    async createDatabaseContext(options: CreateDatabaseContextOptions = {}): Promise<StorageDatabaseContext> {
      const dbPath = path.join(os.tmpdir(), `makaio-conformance-${crypto.randomUUID()}.db`);
      return createSqliteDatabaseContext(dbPath, options);
    },
  };
}
