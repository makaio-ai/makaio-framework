import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { initializeNodeDatabase } from './initialize-node-database.js';

describe('initializeNodeDatabase integration', () => {
  let tempDir: string;
  let dbPath: string;
  let savedDatabaseUrl: string | undefined;
  let savedDatabasePath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-db-init-integration-'));
    dbPath = path.join(tempDir, 'makaio.db');

    // Both env vars participate in target resolution; an ambient value on the
    // developer machine must not re-route the suite's targets.
    savedDatabaseUrl = process.env.MAKAIO_DATABASE_URL;
    savedDatabasePath = process.env.MAKAIO_DATABASE_PATH;
    delete process.env.MAKAIO_DATABASE_URL;
    delete process.env.MAKAIO_DATABASE_PATH;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (savedDatabaseUrl === undefined) {
      delete process.env.MAKAIO_DATABASE_URL;
    } else {
      process.env.MAKAIO_DATABASE_URL = savedDatabaseUrl;
    }
    if (savedDatabasePath === undefined) {
      delete process.env.MAKAIO_DATABASE_PATH;
    } else {
      process.env.MAKAIO_DATABASE_PATH = savedDatabasePath;
    }
  });

  it('creates and migrates a real sqlite database file', async () => {
    const { databaseClient, dbPath: resolvedPath } = await initializeNodeDatabase({ dbPath, makaioHome: tempDir });

    try {
      const stat = await fs.stat(dbPath);
      expect(stat.isFile()).toBe(true);
      expect(resolvedPath).toBe(dbPath);
      const rawSql = getRawSqlExecutor(databaseClient.db);
      const messageRows = await rawSql.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
      );
      expect(messageRows).toHaveLength(1);

      const sessionRows = await rawSql.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`,
      );
      expect(sessionRows).toHaveLength(1);

      // agents is a framework-tier table (declared in @makaio/services-core)
      const agentRows = await rawSql.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'`,
      );
      expect(agentRows).toHaveLength(1);
    } finally {
      await databaseClient.close();
    }
  });

  it('fails actionably for postgres URLs when the pg module cannot be loaded', async () => {
    // beforeEach cleared the var and afterEach restores it — no local juggling.
    process.env.MAKAIO_DATABASE_URL = 'postgres://u:p@localhost:5432/makaio';

    // Fault injection (same pattern as the storage client tests): the test
    // workspace makes 'pg' resolvable, so simulate a host application without
    // the consumer-provided package by making its module resolution throw.
    vi.doMock('pg', () => {
      throw new Error('simulated missing pg module');
    });
    try {
      await expect(initializeNodeDatabase({ makaioHome: tempDir })).rejects.toThrow(/consumer-provided 'pg' package/);
      // URL targets perform no filesystem work — no makaio.db should be created
      await expect(fs.access(path.join(tempDir, 'makaio.db'))).rejects.toThrow();
    } finally {
      vi.doUnmock('pg');
    }
  });
});
