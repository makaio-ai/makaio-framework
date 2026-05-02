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
 * Creates a temp workspace with two packages: services/alpha and libs/beta.
 *
 * - `services/alpha`: single schema at `src/storage/schema.ts`
 * - `libs/beta`: two schemas at `src/schema.ts` and `src/extra.ts`
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
