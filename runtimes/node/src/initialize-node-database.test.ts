import * as fs from 'node:fs/promises';
import * as nodeFsModule from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findStorageEngine, type StorageDialect, type StorageEngine } from '@makaio/storage-drizzle';
import type { DatabaseClient } from '@makaio/storage-drizzle/client';
import { initializeNodeDatabase } from './initialize-node-database.js';

const { closeMock, createDatabaseClientMock, runMigrationsMock, resolveBundledMigrationsDirMock } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  createDatabaseClientMock: vi.fn(),
  runMigrationsMock: vi.fn(),
  resolveBundledMigrationsDirMock: vi.fn(),
}));

vi.mock('@makaio/storage-drizzle/client', async (importOriginal) => {
  // Only client creation is mocked — the engine registry stays real, so URL
  // target discrimination runs against the actual dispatch rule.
  const actual = await importOriginal<typeof import('@makaio/storage-drizzle/client')>();
  return {
    ...actual,
    createDatabaseClient: createDatabaseClientMock,
  };
});

vi.mock('./db-migrations.js', () => ({
  runMigrations: runMigrationsMock,
}));

vi.mock('./resolve-bundled-migrations-dir.js', () => ({
  resolveBundledMigrationsDir: resolveBundledMigrationsDirMock,
}));

/** The registry's documented `globalThis` storage key (used for test cleanup). */
const ENGINE_REGISTRY = Symbol.for('makaio.storage.engineRegistry');

/**
 * View of `globalThis` exposing the registry map for test cleanup. Keyed by a
 * `symbol` index signature rather than the computed `ENGINE_REGISTRY` key,
 * because `Symbol.for` returns a shared (non-`unique`) symbol.
 */
interface EngineRegistryCarrier {
  [key: symbol]: Map<StorageDialect, StorageEngine> | undefined;
}

/**
 * Build a minimal but structurally complete postgres engine for the explicit
 * `database.engines` registration path. Client creation never runs in these
 * tests — `createDatabaseClient` is mocked — so the engine only has to claim
 * postgres URLs.
 * @returns A fresh engine object claiming postgres URLs.
 */
function buildExplicitPostgresEngine(): StorageEngine {
  return {
    dialect: 'postgres',
    matchesUrl: (url) => /^postgres(ql)?:\/\//i.test(url),
    createClient: () => Promise.reject(new Error('test engine does not create clients')),
    errors: {
      isDuplicateObjectError: () => false,
      isUniqueViolationError: () => false,
    },
    capabilities: {
      binaryColumnType: 'bytea',
      maxCounterAssignmentRaces: true,
      tableExists: () => Promise.resolve(false),
    },
    migrations: {
      defaultLedgerTable: '__makaio_migrations',
      journalDialect: 'postgresql',
      chainDirName: 'drizzle-postgres',
      buildLedgerDdl: (tableName) => `CREATE TABLE IF NOT EXISTS "${tableName}" (hash text)`,
      beginTransactionStatement: 'BEGIN',
      extensionLedgerName: (sourceHash) => `__makaio_migrations_${sourceHash}`,
    },
    fts: {
      dialect: 'postgres',
      provisionSearchIndex: () => Promise.resolve(),
      searchMessages: () => Promise.reject(new Error('test engine does not search')),
      searchMessageExcerpts: () => Promise.reject(new Error('test engine does not search')),
      searchSessionRows: () => Promise.reject(new Error('test engine does not search')),
      countSessionMatches: () => Promise.reject(new Error('test engine does not search')),
      fetchFirstUserMessagePreviews: () => Promise.reject(new Error('test engine does not search')),
    },
  };
}

/**
 * Create a host-local `@makaio/storage-pg` fixture package whose identity can
 * only be discovered by resolving from the supplied host root.
 * @param hostRoot - Temporary host install root.
 * @returns Promise resolved after the package fixture has been written.
 */
async function writeHostStoragePgFixture(hostRoot: string): Promise<void> {
  const packageRoot = path.join(hostRoot, 'node_modules', '@makaio', 'storage-pg');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@makaio/storage-pg', version: '0.0.0-test', type: 'module', exports: './index.mjs' }),
  );
  await fs.writeFile(
    path.join(packageRoot, 'index.mjs'),
    `
export const storageEngine = {
  dialect: 'postgres',
  matchesUrl: (url) => /^postgres(ql)?:\\/\\//i.test(url),
  createClient: () => Promise.reject(new Error('fixture engine does not create clients')),
  errors: {
    isDuplicateObjectError: () => false,
    isUniqueViolationError: () => false,
  },
  capabilities: {
    binaryColumnType: 'fixture-bytea',
    maxCounterAssignmentRaces: true,
    tableExists: () => Promise.resolve(false),
  },
  migrations: {
    defaultLedgerTable: '__fixture_migrations',
    journalDialect: 'postgresql',
    chainDirName: 'fixture-drizzle-postgres',
    buildLedgerDdl: (tableName) => \`CREATE TABLE "\${tableName}" (hash text)\`,
    beginTransactionStatement: 'BEGIN',
    extensionLedgerName: (sourceHash) => \`__fixture_migrations_\${sourceHash}\`,
  },
  fts: {
    dialect: 'postgres',
    provisionSearchIndex: () => Promise.resolve(),
    searchMessages: () => Promise.reject(new Error('fixture engine does not search')),
    searchMessageExcerpts: () => Promise.reject(new Error('fixture engine does not search')),
    searchSessionRows: () => Promise.reject(new Error('fixture engine does not search')),
    countSessionMatches: () => Promise.reject(new Error('fixture engine does not search')),
    fetchFirstUserMessagePreviews: () => Promise.reject(new Error('fixture engine does not search')),
  },
};
`,
  );
}

describe('initializeNodeDatabase', () => {
  let tempDir: string;
  let dbPath: string;
  let savedDatabaseUrl: string | undefined;
  let savedDatabasePath: string | undefined;
  let savedPostgresEngine: StorageEngine | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    savedPostgresEngine = findStorageEngine('postgres');
    (globalThis as EngineRegistryCarrier)[ENGINE_REGISTRY]?.delete('postgres');
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-db-init-'));
    dbPath = path.join(tempDir, 'makaio.db');
    await fs.writeFile(dbPath, '');
    const db = {} as DatabaseClient['db'];
    createDatabaseClientMock.mockResolvedValue({
      db,
      close: closeMock,
    } satisfies Partial<DatabaseClient>);
    runMigrationsMock.mockResolvedValue(undefined);
    resolveBundledMigrationsDirMock.mockReturnValue('/tmp/pg-migrations');

    savedDatabaseUrl = process.env.MAKAIO_DATABASE_URL;
    savedDatabasePath = process.env.MAKAIO_DATABASE_PATH;
    delete process.env.MAKAIO_DATABASE_URL;
    delete process.env.MAKAIO_DATABASE_PATH;
  });

  afterEach(async () => {
    // Remove the postgres entry a test registered (explicitly or via URL
    // auto-resolve), or restore a caller-seeded engine if this worker already
    // had one, so the suite only rolls back its own registry changes.
    const registry = (globalThis as EngineRegistryCarrier)[ENGINE_REGISTRY];
    if (savedPostgresEngine === undefined) {
      registry?.delete('postgres');
    } else {
      registry?.set('postgres', savedPostgresEngine);
    }
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

  it('routes postgres URLs to a url target', async () => {
    resolveBundledMigrationsDirMock.mockReturnValue('/tmp/pg-migrations');
    // Spy on node:fs promises property — the production code uses `fs.promises.mkdir`
    // from `import * as fs from 'node:fs'`, so we spy there.
    const mkdirSpy = vi.spyOn(nodeFsModule.promises, 'mkdir').mockResolvedValue(undefined);
    const chmodSpy = vi.spyOn(nodeFsModule.promises, 'chmod').mockResolvedValue(undefined);

    const result = await initializeNodeDatabase({
      makaioHome: tempDir,
      database: {
        url: 'postgres://u:p@localhost:5432/makaio',
        poolMax: 7,
        engines: [buildExplicitPostgresEngine()],
      },
    });

    expect(createDatabaseClientMock).toHaveBeenCalledWith({
      url: 'postgres://u:p@localhost:5432/makaio',
      postgres: { poolMax: 7 },
    });
    expect(runMigrationsMock).toHaveBeenCalledWith(expect.anything(), { migrationsDir: '/tmp/pg-migrations' });
    expect(resolveBundledMigrationsDirMock).toHaveBeenCalledWith('postgres');
    expect(result.dbPath).toBeUndefined();
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(chmodSpy).not.toHaveBeenCalled();

    mkdirSpy.mockRestore();
    chmodSpy.mockRestore();
  });

  it('registers engines passed via database.engines before resolving the target', async () => {
    const engine = buildExplicitPostgresEngine();

    const result = await initializeNodeDatabase({
      makaioHome: tempDir,
      database: { url: 'postgres://u:p@localhost:5432/makaio', engines: [engine] },
    });

    // The explicitly passed engine claimed the URL — no auto-resolve import
    // ran, and the registry holds exactly that object.
    expect(findStorageEngine('postgres')).toBe(engine);
    expect(createDatabaseClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'postgres://u:p@localhost:5432/makaio' }),
    );
    expect(result.dbPath).toBeUndefined();
  });

  it('auto-registers the hinted engine package for unregistered postgres URLs', async () => {
    const hostRoot = path.join(tempDir, 'host-app');
    await writeHostStoragePgFixture(hostRoot);
    expect(findStorageEngine('postgres')).toBeUndefined();

    await initializeNodeDatabase({
      makaioHome: tempDir,
      database: { url: 'postgres://u:p@localhost:5432/makaio', enginePackageImportBasePath: hostRoot },
    });

    const engine = findStorageEngine('postgres');
    if (engine === undefined) {
      throw new Error('Expected host-resolved postgres engine to be registered');
    }
    if (engine.matchesUrl === undefined) {
      throw new Error('Expected host-resolved postgres engine to claim URL targets');
    }
    expect(engine.migrations.chainDirName).toBe('fixture-drizzle-postgres');
    expect(engine.matchesUrl('postgres://fixture')).toBe(true);
  });

  it('MAKAIO_DATABASE_URL outranks dbPath and MAKAIO_DATABASE_PATH', async () => {
    process.env.MAKAIO_DATABASE_URL = 'postgres://env:url@localhost:5432/env';
    process.env.MAKAIO_DATABASE_PATH = path.join(tempDir, 'from-path-env.db');
    resolveBundledMigrationsDirMock.mockReturnValue('/tmp/pg-migrations');

    const result = await initializeNodeDatabase({
      makaioHome: tempDir,
      dbPath: path.join(tempDir, 'explicit.db'),
      database: { engines: [buildExplicitPostgresEngine()] },
    });

    expect(createDatabaseClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'postgres://env:url@localhost:5432/env' }),
    );
    expect(result.dbPath).toBeUndefined();
  });

  it('database.url outranks MAKAIO_DATABASE_URL', async () => {
    process.env.MAKAIO_DATABASE_URL = 'postgres://env:url@localhost:5432/env';
    resolveBundledMigrationsDirMock.mockReturnValue('/tmp/pg-migrations');

    const result = await initializeNodeDatabase({
      makaioHome: tempDir,
      database: {
        url: 'postgres://options:url@localhost:5432/opts',
        engines: [buildExplicitPostgresEngine()],
      },
    });

    expect(createDatabaseClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'postgres://options:url@localhost:5432/opts' }),
    );
    expect(result.dbPath).toBeUndefined();
  });

  it('explicit migrationsDir suppresses the bundled resolver for url targets', async () => {
    const explicitMigrationsDir = path.join(tempDir, 'custom-migrations');

    await initializeNodeDatabase({
      makaioHome: tempDir,
      migrationsDir: explicitMigrationsDir,
      database: {
        url: 'postgres://u:p@localhost:5432/makaio',
        engines: [buildExplicitPostgresEngine()],
      },
    });

    expect(resolveBundledMigrationsDirMock).not.toHaveBeenCalled();
    expect(runMigrationsMock).toHaveBeenCalledWith(expect.anything(), { migrationsDir: explicitMigrationsDir });
  });

  it('rejects unsupported database URL schemes, naming the source and the hinted engine example', async () => {
    let thrown: unknown;
    try {
      await initializeNodeDatabase({
        makaioHome: tempDir,
        database: { url: 'libsql://remote.example' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('postgres://');
    expect(message).toContain('@makaio/storage-pg');
    expect(message).toContain("'database.url' boot option");
    expect(createDatabaseClientMock).not.toHaveBeenCalled();
  });

  it('redacts credentials and names the boot option in the unsupported-URL error', async () => {
    let thrown: unknown;
    try {
      // Typo'd scheme with credentials in both userinfo and the query string —
      // libpq/node-postgres accept `password` as a URI query parameter, so the
      // search component is a leak vector too.
      await initializeNodeDatabase({
        makaioHome: tempDir,
        database: { url: 'postgress://dbuser:s3cret-pw@prod-host:5432/makaio?password=qs-s3cret&user=qs-user' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain('s3cret-pw');
    expect(message).not.toContain('dbuser');
    expect(message).not.toContain('qs-s3cret');
    expect(message).not.toContain('qs-user');
    expect(message).toContain('prod-host');
    expect(message).toContain("'database.url' boot option");
  });

  it('redacts authority-less URLs to a scheme-only fragment instead of leaking the pathname', async () => {
    // A canonical libpq credential URL missing one slash parses without an
    // authority: the WHATWG parser shifts `user:pw@host/...` into the
    // pathname, so emitting the pathname would leak the credentials.
    for (const mangledUrl of [
      'postgres:/dbuser:s3cret-pw@prod-host:5432/makaio',
      'postgres:dbuser:s3cret-pw@prod-host/makaio',
    ]) {
      let thrown: unknown;
      try {
        await initializeNodeDatabase({ makaioHome: tempDir, database: { url: mangledUrl } });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).not.toContain('s3cret-pw');
      expect(message).not.toContain('dbuser');
      expect(message).toContain('postgres:…');
    }
  });

  it('names MAKAIO_DATABASE_URL in the unsupported-URL error when the env var supplied the candidate', async () => {
    process.env.MAKAIO_DATABASE_URL = 'mysql://dbuser:s3cret-pw@db-host/makaio';

    let thrown: unknown;
    try {
      await initializeNodeDatabase({ makaioHome: tempDir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain('s3cret-pw');
    expect(message).toContain('MAKAIO_DATABASE_URL environment variable');
  });

  it('treats an empty MAKAIO_DATABASE_URL as unset and falls through to the file chain', async () => {
    process.env.MAKAIO_DATABASE_URL = '';

    const result = await initializeNodeDatabase({ dbPath, makaioHome: tempDir });

    expect(createDatabaseClientMock).toHaveBeenCalledWith({
      url: pathToFileURL(dbPath).href,
    });
    expect(result.dbPath).toBe(dbPath);
  });

  it('treats an empty MAKAIO_DATABASE_PATH as unset and falls back to the makaioHome default', async () => {
    process.env.MAKAIO_DATABASE_PATH = '';

    const result = await initializeNodeDatabase({ makaioHome: tempDir });

    expect(createDatabaseClientMock).toHaveBeenCalledWith({
      url: pathToFileURL(path.join(tempDir, 'makaio.db')).href,
    });
    expect(result.dbPath).toBe(path.join(tempDir, 'makaio.db'));
  });

  it('closes the client when the bundled resolver throws', async () => {
    resolveBundledMigrationsDirMock.mockImplementation(() => {
      throw new Error('resolver probe failed');
    });

    await expect(
      initializeNodeDatabase({
        makaioHome: tempDir,
        database: {
          url: 'postgres://u:p@localhost:5432/makaio',
          engines: [buildExplicitPostgresEngine()],
        },
      }),
    ).rejects.toThrow('resolver probe failed');

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative dbPath option to an absolute path', async () => {
    // The result contract documents dbPath as absolute, so relative values
    // must come back resolved against the working directory. The mocked
    // client never opens the file; only mkdir/chmod would touch the
    // filesystem, so both are stubbed to keep the test write-free.
    const mkdirSpy = vi.spyOn(nodeFsModule.promises, 'mkdir').mockResolvedValue(undefined);
    const chmodSpy = vi.spyOn(nodeFsModule.promises, 'chmod').mockResolvedValue(undefined);
    const relativeDbPath = path.join('relative-dir', 'makaio.db');
    const absoluteDbPath = path.resolve(relativeDbPath);

    try {
      const result = await initializeNodeDatabase({ dbPath: relativeDbPath, makaioHome: tempDir });

      expect(result.dbPath).toBe(absoluteDbPath);
      expect(path.isAbsolute(result.dbPath ?? '')).toBe(true);
      expect(createDatabaseClientMock).toHaveBeenCalledWith({
        url: pathToFileURL(absoluteDbPath).href,
      });
    } finally {
      mkdirSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it('MAKAIO_DATABASE_PATH still selects the file path when no URL is set', async () => {
    const customPath = path.join(tempDir, 'subdir', 'custom.db');
    process.env.MAKAIO_DATABASE_PATH = customPath;
    // The mocked client never touches the filesystem; pre-create the file so the
    // production chmod hardening finds it (same convention as the beforeEach db file).
    await fs.mkdir(path.dirname(customPath), { recursive: true });
    await fs.writeFile(customPath, '');

    const result = await initializeNodeDatabase({ makaioHome: tempDir });

    expect(createDatabaseClientMock).toHaveBeenCalledWith({
      url: pathToFileURL(customPath).href,
    });
    expect(result.dbPath).toBe(customPath);
  });
});
