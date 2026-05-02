import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeNodeDatabase } from './initialize-node-database.js';

describe('initializeNodeDatabase integration', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-db-init-integration-'));
    dbPath = path.join(tempDir, 'makaio.db');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates and migrates a real sqlite database file', async () => {
    const { databaseClient, dbPath: resolvedPath } = await initializeNodeDatabase({ dbPath, makaioHome: tempDir });

    try {
      const stat = await fs.stat(dbPath);
      expect(stat.isFile()).toBe(true);
      expect(resolvedPath).toBe(dbPath);
      const messageRows = await databaseClient.db.run(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
      );
      expect(messageRows.rows).toHaveLength(1);

      const sessionRows = await databaseClient.db.run(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`,
      );
      expect(sessionRows.rows).toHaveLength(1);

      // agents is a framework-tier table (declared in @makaio/services-core)
      const agentRows = await databaseClient.db.run(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'`,
      );
      expect(agentRows.rows).toHaveLength(1);
    } finally {
      databaseClient.close();
    }
  });
});
