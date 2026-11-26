import { randomUUID } from 'node:crypto';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { applyMigrations } from '@makaio/storage-migrations';
import { sql } from 'drizzle-orm';
import { readCentralChain } from '../../../../../storage/conformance/src/harness/chains.js';
import {
  buildPostgresOptionsUrl,
  ensurePostgresEngineRegistered,
} from '../../../../../storage/conformance/src/harness/postgres-config.js';
import {
  openPostgresWithHeldListener,
  type HeldListenerOptions,
} from '../../../../../storage/pg/src/__tests__/held-listener-fixture.js';
import { POSTGRES_WAKE_CHANNEL } from '../../../../../storage/pg/src/signal-listener.js';
import { migrateRedemptionOwner } from './redemption-owner-fixture.js';

/**
 * Open an isolated database in the parent or either generation of host.
 * @param url - Database endpoint owned by the test.
 * @param heldListener - Optional test-only control of its PostgreSQL signal connection.
 * @returns Storage with the underlying driver lifetime.
 */
export async function openExchangeDatabase(url: string, heldListener?: HeldListenerOptions) {
  const dialect = url.startsWith('file:') ? 'sqlite' : 'postgres';
  if (dialect === 'postgres') ensurePostgresEngineRegistered();
  const { db, close } =
    heldListener === undefined
      ? await createDatabaseClient({ url })
      : await openPostgresWithHeldListener(url, heldListener);
  return { db, dialect, executor: getRawSqlExecutor(db), cleanup: async () => void (await close()) } as const;
}

/**
 * Terminate the single dedicated signal connection of this exchange test.
 * @param url - The case's isolated PostgreSQL endpoint.
 * @param applicationName - This case's unique tag on its listener only.
 */
export async function terminateExchangeTestListener(url: string, applicationName: string): Promise<void> {
  const storage = await openExchangeDatabase(url);
  try {
    const rows = await storage.executor.all<{ terminated: boolean }>(sql`
      SELECT pg_terminate_backend((
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${applicationName}
          AND state = 'idle' AND query = ${`LISTEN ${POSTGRES_WAKE_CHANNEL}`}
      )) AS terminated
    `);
    if (rows[0]?.terminated !== true) throw new Error('Could not terminate the tagged worker exchange listener');
  } finally {
    await storage.cleanup();
  }
}

/**
 * Install the actual worker dispatch migration and the persisted test owner.
 * @param url - Empty SQLite template or isolated PostgreSQL schema.
 */
async function migrate(url: string): Promise<void> {
  const storage = await openExchangeDatabase(url);
  try {
    const migrations = readCentralChain(storage.dialect).filter(
      ({ tag }) => tag.endsWith('_worker-dispatch') || tag.endsWith('_journal-core'),
    );
    if (migrations.length !== 2) throw new Error('Missing worker exchange fixture migrations');
    await applyMigrations(storage.db, migrations);
    await migrateRedemptionOwner(storage);
    // Native SQLite readers of the copy cannot see the template's WAL.
    if (storage.dialect === 'sqlite') await storage.executor.all(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  } finally {
    await storage.cleanup();
  }
}

/**
 * Create a closed SQLite template once; each test gets its own copy.
 * @param directory - Parent-owned temporary files.
 */
export async function prepareExchangeDatabase(directory: string): Promise<void> {
  if (process.env['MAKAIO_STORAGE_TEST_DIALECT'] !== 'postgres') {
    await migrate(`file:${join(directory, 'template.db')}`);
  }
}

/**
 * Allocate storage which is independent of the child process lifetimes.
 * @param directory - Parent-owned temporary files and SQLite template.
 * @param seed - Whether to install the exchange-only fixture schema instead of leaving migrations to full boot.
 * @returns Private endpoint and teardown for one test.
 */
export async function createRestartDatabase(directory: string, seed = true) {
  const id = randomUUID().replaceAll('-', '');
  if (process.env['MAKAIO_STORAGE_TEST_DIALECT'] !== 'postgres') {
    const file = join(directory, `${id}.db`);
    if (seed) await copyFile(join(directory, 'template.db'), file);
    return { url: `file:${file}`, cleanup: async () => void (await rm(file, { force: true })) };
  }
  ensurePostgresEngineRegistered();
  const url = process.env['MAKAIO_STORAGE_TEST_URL'] ?? '';
  if (url === '') throw new Error('Missing isolated PostgreSQL test connection');
  const admin = await createDatabaseClient({ url });
  const schemaName = `worker_exchange_${id}`;
  const schema = sql.identifier(schemaName);
  const executor = getRawSqlExecutor(admin.db);
  const cleanup = async (): Promise<void> => {
    try {
      await executor.run(sql`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
  };
  const isolatedUrl = buildPostgresOptionsUrl(url, { search_path: schemaName });
  try {
    await executor.run(sql`CREATE SCHEMA ${schema}`);
    if (seed) await migrate(isolatedUrl);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { url: isolatedUrl, cleanup };
}
