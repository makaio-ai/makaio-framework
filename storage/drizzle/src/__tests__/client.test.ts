/**
 * Tests for {@link createDatabaseClient}.
 *
 * All tests use real in-memory or temporary file-based SQLite databases
 * via runtime-selected SQLite drivers (`bun:sqlite` under Bun, `@libsql/client` under Node.js) — no mocks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabaseClient } from '../client';
import type { DatabaseClient } from '../client';
import type { MakaioDatabase } from '../types';

// ---------------------------------------------------------------------------
// Helper — extract the scalar value from a single-column PRAGMA result row.
// ---------------------------------------------------------------------------

/**
 * Reads the first column value from a PRAGMA result row.
 * @param row - Single PRAGMA result row returned by drizzle's `db.all`.
 * @returns The scalar value of the first column, or `undefined` when the row is absent.
 */
function pragmaValue(row: Record<string, unknown> | undefined): unknown {
  if (!row) {
    return undefined;
  }
  const values = Object.values(row);
  if (values.length !== 1) {
    throw new Error(`Expected single-column PRAGMA row, received ${values.length} columns`);
  }
  const [value] = values;
  return value;
}

/**
 * Reads a single-column PRAGMA value from the given database and asserts that exactly one row was returned.
 * @param db - Database client used for the PRAGMA query.
 * @param pragma - PRAGMA name without the `PRAGMA` keyword.
 * @returns The scalar value from the single PRAGMA row.
 */
async function readPragmaValue(db: DatabaseClient['db'], pragma: string): Promise<unknown> {
  const rows = await db.all<Record<string, unknown>>(sql.raw(`PRAGMA ${pragma}`));
  expect(rows).toHaveLength(1);
  return pragmaValue(rows[0]);
}

// ---------------------------------------------------------------------------
// Helper — create a unique temp-file path for file-based tests.
// ---------------------------------------------------------------------------

/**
 * Returns a unique path under the OS temp directory for a test SQLite file.
 * @returns Absolute path string that does not yet exist on disk.
 */
function tempDbPath(): string {
  return path.join(os.tmpdir(), `makaio-drizzle-client-test-${crypto.randomUUID()}.db`);
}

/**
 * Best-effort removal of a SQLite database file and its sidecars.
 * @param dbFilePath - Absolute path to the main SQLite database file.
 */
function deleteSqliteArtifacts(dbFilePath: string): void {
  for (const candidatePath of [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`]) {
    try {
      fs.unlinkSync(candidatePath);
    } catch {
      // Files may not exist if SQLite/libsql deferred creation — ignore.
    }
  }
}

type AssertFalse<T extends false> = T;
type _NoBatchOnMakaioDatabase = AssertFalse<MakaioDatabase extends { batch: unknown } ? true : false>;
type _NoClientOnMakaioDatabase = AssertFalse<MakaioDatabase extends { $client: unknown } ? true : false>;
type _NoResultKindOnMakaioDatabase = AssertFalse<MakaioDatabase extends { resultKind: unknown } ? true : false>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDatabaseClient', () => {
  // Track clients opened within each test for guaranteed cleanup.
  let openClients: DatabaseClient[] = [];
  let filesToCleanup: string[] = [];

  afterEach(() => {
    const closeErrors: unknown[] = [];

    for (const client of openClients) {
      try {
        client.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    openClients = [];

    for (const dbFilePath of filesToCleanup) {
      deleteSqliteArtifacts(dbFilePath);
    }
    filesToCleanup = [];

    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, 'One or more DatabaseClient.close() calls failed during test teardown');
    }
  });

  /**
   * Registers a client for automatic afterEach cleanup and returns it unchanged.
   * @param client - The database client to track.
   * @returns The same client, for chaining.
   */
  function track(client: DatabaseClient): DatabaseClient {
    openClients.push(client);
    return client;
  }

  /**
   * Registers a SQLite file path for cleanup after all tracked clients close.
   * @param dbFilePath - Absolute SQLite file path.
   * @returns The same path, for inline assignment.
   */
  function trackDbFile(dbFilePath: string): string {
    filesToCleanup.push(dbFilePath);
    return dbFilePath;
  }

  // -------------------------------------------------------------------------
  // In-memory database
  // -------------------------------------------------------------------------

  describe('in-memory database (:memory: URL)', () => {
    it('returns a db instance that can execute a simple SQL statement', async () => {
      const { db } = track(await createDatabaseClient({ url: ':memory:' }));

      const rows = await db.all<{ val: number }>(sql`SELECT 1 AS val`);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.val).toBe(1);
    });

    it('keeps journal mode in memory', async () => {
      const { db } = track(await createDatabaseClient({ url: ':memory:' }));

      expect(String(await readPragmaValue(db, 'journal_mode')).toLowerCase()).toBe('memory');
    });

    it('keeps busy_timeout at the SQLite default', async () => {
      const { db } = track(await createDatabaseClient({ url: ':memory:' }));

      expect(Number(await readPragmaValue(db, 'busy_timeout'))).toBe(0);
    });

    it('applies foreign_keys = ON', async () => {
      const { db } = track(await createDatabaseClient({ url: ':memory:' }));

      expect(Number(await readPragmaValue(db, 'foreign_keys'))).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // File-based database
  // -------------------------------------------------------------------------

  describe('file-based database (file: URL)', () => {
    /**
     * Creates and tracks a file-backed client under a unique temp path.
     * @returns Tracked file path and client for file-backed assertions.
     */
    async function createTrackedFileClient(): Promise<{ dbFilePath: string; client: DatabaseClient }> {
      const dbFilePath = trackDbFile(tempDbPath());
      const client = track(await createDatabaseClient({ url: `file:${dbFilePath}` }));
      return { dbFilePath, client };
    }

    it('returns a db instance that can execute a simple SQL statement', async () => {
      const { client } = await createTrackedFileClient();
      const { db } = client;

      const rows = await db.all<{ val: number }>(sql`SELECT 1 AS val`);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.val).toBe(1);
    });

    it('applies WAL journal mode', async () => {
      const { client } = await createTrackedFileClient();
      const { db } = client;

      expect(String(await readPragmaValue(db, 'journal_mode')).toLowerCase()).toBe('wal');
    });

    it('applies busy_timeout = 5000', async () => {
      const { client } = await createTrackedFileClient();
      const { db } = client;

      expect(Number(await readPragmaValue(db, 'busy_timeout'))).toBe(5000);
    });

    it('applies foreign_keys = ON', async () => {
      const { client } = await createTrackedFileClient();
      const { db } = client;

      expect(Number(await readPragmaValue(db, 'foreign_keys'))).toBe(1);
    });

    it('creates the database file on disk', async () => {
      const { dbFilePath } = await createTrackedFileClient();

      expect(fs.existsSync(dbFilePath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Remote URLs — PRAGMAs must NOT be applied
  // -------------------------------------------------------------------------

  describe('remote URL (non-file: scheme)', () => {
    it('does not apply PRAGMAs and returns without error for http:// scheme', async () => {
      // We cannot open a real remote connection in unit tests, but we can
      // verify the factory's branching behaviour: for a non-file URL the
      // PRAGMA block is skipped and the factory returns the raw db/close pair
      // without executing any SQL.  The drizzle instance is lazy — it only
      // connects when a query is executed, so constructing it with a bogus
      // remote URL does not throw.
      const client = track(await createDatabaseClient({ url: 'http://localhost:18080' }));

      // We intentionally do NOT call client.db.run() here because there is no
      // server listening.  The contract being tested is purely that
      // createDatabaseClient resolves (i.e. the PRAGMA block is skipped) and
      // that the returned shape is correct.
      expect(typeof client.db).toBe('object');
      expect(typeof client.close).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // Default URL fallback
  // -------------------------------------------------------------------------

  describe('default URL', () => {
    it('uses file:./makaio.db when no url is provided — constructor resolves', async () => {
      const originalCwd = process.cwd();
      const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-drizzle-client-default-url-'));
      // This test does not need `it.sequential()`: Vitest runs this file's
      // tests sequentially, and the repo's forked-worker pool isolates this
      // cwd mutation from other test files.
      process.chdir(tempCwd);

      // createDatabaseClient() with no args defaults to 'file:./makaio.db'.
      // The factory applies PRAGMAs eagerly, which means it actually opens
      // (and creates) the file.  We want to verify the factory resolves and
      // clean up any file it creates inside an isolated temp working directory.
      const defaultDbPath = path.resolve('makaio.db');
      try {
        const client = await createDatabaseClient();
        track(client);

        expect(typeof client.db).toBe('object');
        expect(typeof client.close).toBe('function');

        // Eagerly close to release the file lock before cleanup.
        client.close();
        openClients = openClients.filter((c) => c !== client);

        deleteSqliteArtifacts(defaultDbPath);
      } finally {
        process.chdir(originalCwd);
        try {
          fs.rmSync(tempCwd, { recursive: true, force: true });
        } catch {
          // Ignore temp-dir cleanup failures on CI filesystem edges.
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // close() lifecycle
  // -------------------------------------------------------------------------

  describe('close()', () => {
    it('does not throw when called once', async () => {
      const client = track(await createDatabaseClient({ url: ':memory:' }));

      expect(() => client.close()).not.toThrow();
    });

    it('does not throw when called multiple times', async () => {
      const client = track(await createDatabaseClient({ url: ':memory:' }));

      client.close();

      // A second call must also be safe (the interface contract documents this).
      expect(() => client.close()).not.toThrow();
    });
  });
});
