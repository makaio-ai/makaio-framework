/**
 * Shared fixture of the SQLite handle suites (serialization, re-entrancy,
 * close): a file-backed handle with a `t (id)` table, closed and deleted after
 * each test.
 *
 * File-backed databases are used throughout: libsql opens a fresh connection
 * after each transaction, which only a file shares between connections.
 */
import { afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabaseClient, type DatabaseClient } from '../client';
import { getRawSqlExecutor, type RawSqlExecutor } from '../raw-sql';
import type { MakaioDatabase } from '../types';
import { removeDatabaseFiles } from './temp-database';

/** Handle under test together with its raw statement surface. */
export interface Handle {
  readonly client: DatabaseClient;
  readonly db: MakaioDatabase;
  readonly raw: RawSqlExecutor;
  /** Absolute path of the handle's database file. */
  readonly databaseFile: string;
}

/** Entry points of {@link useHandleFixture}. */
export interface HandleFixture {
  /**
   * Open a fresh file-backed handle with an empty `t (id)` table.
   * @returns The handle and its raw statement surface.
   */
  openHandle(): Promise<Handle>;
  /**
   * Read the ids stored in the `t` table of a handle.
   * @param handle - Handle to read through.
   * @returns Stored ids in ascending order.
   */
  readIds(handle: Handle): Promise<string[]>;
}

/**
 * Wait long enough for work that is not blocked to have run.
 * @param milliseconds - Time to wait.
 */
export async function pause(milliseconds = 25): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Register the per-test teardown of the handles a suite opens.
 * @param label - Label embedded in the database file names.
 * @returns The suite's handle opener and reader.
 */
export function useHandleFixture(label: string): HandleFixture {
  const opened: Handle[] = [];

  afterEach(async () => {
    for (const handle of opened.splice(0)) {
      try {
        await handle.client.close();
      } finally {
        removeDatabaseFiles(handle.databaseFile);
      }
    }
  });

  return {
    async openHandle() {
      const databaseFile = path.join(os.tmpdir(), `makaio-${label}-${crypto.randomUUID()}.db`);
      const client = await createDatabaseClient({ url: `file:${databaseFile}` });
      const raw = getRawSqlExecutor(client.db);
      const handle: Handle = { client, db: client.db, raw, databaseFile };
      opened.push(handle);
      await raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
      return handle;
    },
    async readIds(handle) {
      const rows = await handle.raw.all<{ id: string }>(sql`SELECT id FROM t ORDER BY id`);
      return rows.map((row) => row.id);
    },
  };
}
