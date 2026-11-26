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
import { migrateRedemptionOwner } from './redemption-owner-fixture.js';

/**
 * Open an isolated database in the parent or either generation of host.
 * @param url - Database endpoint owned by the test.
 * @returns Storage with the underlying driver lifetime.
 */
export async function openExchangeDatabase(url: string) {
  const dialect = url.startsWith('file:') ? 'sqlite' : 'postgres';
  if (dialect === 'postgres') ensurePostgresEngineRegistered();
  const { db, close } = await createDatabaseClient({ url });
  return { db, dialect, executor: getRawSqlExecutor(db), cleanup: async () => void (await close()) } as const;
}

/**
 * Install the actual worker dispatch migration and the persisted test owner.
 * @param url - Empty SQLite template or isolated PostgreSQL schema.
 */
async function migrate(url: string): Promise<void> {
  const storage = await openExchangeDatabase(url);
  try {
    const dispatch = readCentralChain(storage.dialect).find(({ tag }) => tag.endsWith('_worker-dispatch'));
    if (dispatch === undefined) throw new Error('Missing worker dispatch migration');
    await applyMigrations(storage.db, [dispatch]);
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
 * @returns Private endpoint and teardown for one test.
 */
export async function createRestartDatabase(directory: string) {
  const id = randomUUID().replaceAll('-', '');
  if (process.env['MAKAIO_STORAGE_TEST_DIALECT'] !== 'postgres') {
    const file = join(directory, `${id}.db`);
    await copyFile(join(directory, 'template.db'), file);
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
    await migrate(isolatedUrl);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { url: isolatedUrl, cleanup };
}
