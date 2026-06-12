/**
 * Shared test utilities for storage-migration tests.
 */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Writes a JSON object to a file.
 * @param filePath - Target file path
 * @param data - Data to serialise
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Ensures a directory exists (recursive).
 * @param dirPath - Directory to create
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Creates a temp workspace with two packages using legacy forms:
 *
 * - `services/alpha`: single schema at `src/storage/schema.ts` (bare string form)
 * - `libs/beta`: two schemas at `src/schema.ts` and `src/extra.ts` (array form)
 *
 * Both packages use the legacy `drizzleSchema` form (string | string[]) and are
 * therefore treated as sqlite-only. These serve as regression coverage for the
 * legacy back-compat path.
 * @returns Root directory of the workspace
 */
export async function createTestWorkspace(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-'));

  await writeJson(path.join(tempDir, 'package.json'), {
    workspaces: ['services/*', 'libs/*'],
  });

  const servicesRoot = path.join(tempDir, 'services', 'alpha');
  await ensureDir(path.join(servicesRoot, 'src', 'storage'));
  await writeJson(path.join(servicesRoot, 'package.json'), {
    name: '@makaio/services-alpha',
    makaio: { drizzleSchema: './src/storage/schema.ts' },
  });
  await writeFile(path.join(servicesRoot, 'src', 'storage', 'schema.ts'), 'export const alpha = true;\n');

  const libsRoot = path.join(tempDir, 'libs', 'beta');
  await ensureDir(path.join(libsRoot, 'src'));
  await writeJson(path.join(libsRoot, 'package.json'), {
    name: '@makaio/libs-beta',
    makaio: { drizzleSchema: ['./src/schema.ts', './src/extra.ts'] },
  });
  await writeFile(path.join(libsRoot, 'src', 'schema.ts'), 'export const beta = true;\n');
  await writeFile(path.join(libsRoot, 'src', 'extra.ts'), 'export const extra = true;\n');

  return tempDir;
}

/**
 * Creates a temp workspace with one package using the object form of
 * `drizzleSchema`, declaring both SQLite and Postgres schema paths.
 *
 * Package layout:
 * - `services/dual`: object form with `sqlite` and `postgres` arrays, each
 *   containing one file (`src/schema.ts` and `src/schema.postgres.ts`).
 *
 * Both files are created so existence-checks pass.
 * @returns Root directory of the workspace
 */
export async function createDualDialectWorkspace(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-dual-'));

  await writeJson(path.join(tempDir, 'package.json'), {
    workspaces: ['services/*'],
  });

  const pkgRoot = path.join(tempDir, 'services', 'dual');
  await ensureDir(path.join(pkgRoot, 'src'));
  await writeJson(path.join(pkgRoot, 'package.json'), {
    name: '@makaio/services-dual',
    makaio: {
      drizzleSchema: {
        sqlite: ['./src/schema.ts'],
        postgres: ['./src/schema.postgres.ts'],
      },
    },
  });
  await writeFile(path.join(pkgRoot, 'src', 'schema.ts'), 'export const dualSqlite = true;\n');
  await writeFile(path.join(pkgRoot, 'src', 'schema.postgres.ts'), 'export const dualPostgres = true;\n');

  return tempDir;
}

/**
 * Writes a package with the object form declaring `postgres` entries only (no
 * `sqlite`), which is an unconditional declaration error.
 *
 * The package is added inside an existing workspace directory; the caller is
 * responsible for creating the workspace root and its `package.json`.
 * @param workspaceRoot - Root of the temporary workspace.
 * @param pkgSubPath - Relative path under the workspace root for the package.
 * @param pkgName - Package `name` to write.
 * @returns Absolute path to the package root.
 */
export async function writePostgresWithoutSqlitePackage(
  workspaceRoot: string,
  pkgSubPath: string,
  pkgName: string,
): Promise<string> {
  const pkgRoot = path.join(workspaceRoot, pkgSubPath);
  await ensureDir(path.join(pkgRoot, 'src'));
  await writeJson(path.join(pkgRoot, 'package.json'), {
    name: pkgName,
    makaio: {
      drizzleSchema: {
        postgres: ['./src/schema.postgres.ts'],
      },
    },
  });
  await writeFile(path.join(pkgRoot, 'src', 'schema.postgres.ts'), 'export const pgOnly = true;\n');
  return pkgRoot;
}

/**
 * Writes a package with the legacy sqlite-only form (no `postgres` entries).
 *
 * The package is added inside an existing workspace directory; the caller is
 * responsible for creating the workspace root and its `package.json`.
 * @param workspaceRoot - Root of the temporary workspace.
 * @param pkgSubPath - Relative path under the workspace root for the package.
 * @param pkgName - Package `name` to write.
 * @returns Absolute path to the package root.
 */
export async function writeSqliteOnlyPackage(
  workspaceRoot: string,
  pkgSubPath: string,
  pkgName: string,
): Promise<string> {
  const pkgRoot = path.join(workspaceRoot, pkgSubPath);
  await ensureDir(path.join(pkgRoot, 'src'));
  await writeJson(path.join(pkgRoot, 'package.json'), {
    name: pkgName,
    makaio: { drizzleSchema: './src/schema.ts' },
  });
  await writeFile(path.join(pkgRoot, 'src', 'schema.ts'), 'export const sqliteOnly = true;\n');
  return pkgRoot;
}
