import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@makaio/storage-drizzle/client';
import { initializeNodeDatabase } from './initialize-node-database.js';

const { closeMock, createDatabaseClientMock, runMigrationsMock } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  createDatabaseClientMock: vi.fn(),
  runMigrationsMock: vi.fn(),
}));

vi.mock('@makaio/storage-drizzle/client', () => ({
  createDatabaseClient: createDatabaseClientMock,
}));

vi.mock('./db-migrations.js', () => ({
  runMigrations: runMigrationsMock,
}));

describe('initializeNodeDatabase', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-db-init-'));
    dbPath = path.join(tempDir, 'makaio.db');
    await fs.writeFile(dbPath, '');
    const db = {} as DatabaseClient['db'];
    createDatabaseClientMock.mockResolvedValue({
      db,
      close: closeMock,
    } satisfies Partial<DatabaseClient>);
    runMigrationsMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates the database client with a file URL', async () => {
    const result = await initializeNodeDatabase({ dbPath, makaioHome: tempDir });

    expect(createDatabaseClientMock).toHaveBeenCalledWith({
      url: pathToFileURL(dbPath).href,
    });
    expect(result.dbPath).toBe(dbPath);
  });

  it('passes bundled migration directories to the migration runner', async () => {
    const migrationsDir = path.join(tempDir, 'drizzle');

    await initializeNodeDatabase({ dbPath, makaioHome: tempDir, migrationsDir });

    expect(runMigrationsMock).toHaveBeenCalledWith(expect.anything(), { migrationsDir });
  });

  it('closes the created database client when migrations fail', async () => {
    runMigrationsMock.mockRejectedValueOnce(new Error('migration failed'));

    await expect(initializeNodeDatabase({ dbPath, makaioHome: tempDir })).rejects.toThrow('migration failed');

    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
