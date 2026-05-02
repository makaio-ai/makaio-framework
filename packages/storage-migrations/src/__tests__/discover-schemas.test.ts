import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverSchemas } from '../discover-schemas.js';
import { createTestWorkspace, writeJson, ensureDir } from './shared.js';

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('discoverSchemas', () => {
  it('discovers schemas from workspace globs in package.json', async () => {
    tempDir = await createTestWorkspace();

    const schemas = await discoverSchemas(tempDir);
    const schemaPaths = schemas.map((schema) => schema.schemaPath);

    const servicesRoot = path.join(tempDir, 'services', 'alpha');
    const libsRoot = path.join(tempDir, 'libs', 'beta');

    expect(schemas.map((schema) => schema.packageName)).toEqual([
      '@makaio/libs-beta',
      '@makaio/libs-beta',
      '@makaio/services-alpha',
    ]);
    expect(schemaPaths).toEqual([
      path.resolve(libsRoot, 'src', 'extra.ts'),
      path.resolve(libsRoot, 'src', 'schema.ts'),
      path.resolve(servicesRoot, 'src', 'storage', 'schema.ts'),
    ]);
  });

  it('throws when a declared schema file is missing', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-'));

    await writeJson(path.join(tempDir, 'package.json'), {
      workspaces: { packages: ['services/*'] },
    });

    const servicesRoot = path.join(tempDir, 'services', 'gamma');
    await ensureDir(servicesRoot);
    await writeJson(path.join(servicesRoot, 'package.json'), {
      name: '@makaio/services-gamma',
      makaio: { drizzleSchema: './src/storage/schema.ts' },
    });

    await expect(discoverSchemas(tempDir)).rejects.toThrow('Schema file not found');
  });
});
