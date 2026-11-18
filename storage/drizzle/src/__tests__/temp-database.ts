/**
 * Temporary file-backed SQLite databases for this package's own tests.
 *
 * libsql hands its connection to every transaction, so an in-memory database
 * does not survive one: the factory rejects in-memory URLs on that driver.
 * Tests that need a throwaway database therefore use a temporary file, which
 * every connection of a handle shares.
 *
 * `@makaio/test-utils` hosts the same helper for every other package; it
 * cannot be used here because it depends on this package.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabaseClient, type DatabaseClient } from '../client';

/**
 * Return a unique, not yet existing database file path under the OS temp directory.
 * @param name - Label embedded in the file name.
 * @returns Absolute path of a database file for one test.
 */
export function tempDatabasePath(name: string): string {
  return path.join(os.tmpdir(), `makaio-${name}-test-${crypto.randomUUID()}.db`);
}

/**
 * Delete a database file together with the WAL sidecars SQLite leaves beside it.
 * @param databaseFile - Absolute path of the main database file.
 */
export function removeDatabaseFiles(databaseFile: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${databaseFile}${suffix}`, { force: true });
}

/**
 * Create a client on a fresh temporary database file.
 *
 * `close()` closes the connection, then deletes the file and its WAL
 * sidecars. It may be called repeatedly; a close that fails or has to wait
 * keeps the files until the connection is closed.
 * @param name - Label embedded in the file name.
 * @returns A client whose `close()` also removes the database files.
 */
export async function createTempDatabaseClient(name: string): Promise<DatabaseClient> {
  const databaseFile = tempDatabasePath(name);
  const client = await createDatabaseClient({ url: `file:${databaseFile}` });
  return {
    db: client.db,
    dialect: client.dialect,
    close: createFileRemovingClose(client, () => removeDatabaseFiles(databaseFile)),
  };
}

/**
 * Wrap a client's `close()` so the files are removed once the connection is closed.
 *
 * Every call goes to the client's own `close()`: idempotency, retry after a
 * failed release and the rejection of a close from inside a transaction live
 * there, and a result cached here would outlive a failure the client lets be
 * retried. Removal follows the client's timing (synchronously when the close
 * completes synchronously, once it settled when it had to wait for an open
 * transaction) and only after a close that succeeded: a close that failed or
 * was rejected leaves the handle open, so its files stay. Removal is idempotent,
 * so repeated calls simply repeat it.
 * @param client - Client whose `close()` is wrapped.
 * @param removeFiles - Removal of the client's database files.
 * @returns A `close()` that is safe to call repeatedly.
 */
function createFileRemovingClose(client: DatabaseClient, removeFiles: () => void): DatabaseClient['close'] {
  return () => {
    const result = client.close();
    if (result instanceof Promise) return result.then(removeFiles);
    removeFiles();
    return result;
  };
}
