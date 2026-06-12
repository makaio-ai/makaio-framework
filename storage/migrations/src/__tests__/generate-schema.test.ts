import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { generateSchema } from '../generate-schema.js';
import { createTestWorkspace, createDualDialectWorkspace } from './shared.js';

let tempDir: string | null = null;

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('generateSchema', () => {
  it('writes a deterministic .generated/schema.ts for a temp workspace', async () => {
    tempDir = await createTestWorkspace();

    const servicesRoot = path.join(tempDir, 'services', 'alpha');
    const libsRoot = path.join(tempDir, 'libs', 'beta');
    const generatedDir = path.join(tempDir, '.generated');
    const logger = { info: vi.fn() };

    await generateSchema({ workspaceRoot: tempDir, generatedDir, logger });

    const schemaPath = path.join(generatedDir, 'schema.ts');
    const schemaContents = await readFile(schemaPath, 'utf-8');

    const expected = [
      `export * from '${toPosix(path.resolve(libsRoot, 'src', 'extra.ts'))}';`,
      `export * from '${toPosix(path.resolve(libsRoot, 'src', 'schema.ts'))}';`,
      `export * from '${toPosix(path.resolve(servicesRoot, 'src', 'storage', 'schema.ts'))}';`,
      '',
    ].join('\n');

    expect(schemaContents).toBe(expected);
  });

  it('default call (no dialects option) writes ONLY schema.ts, not schema.postgres.ts', async () => {
    tempDir = await createTestWorkspace();
    const generatedDir = path.join(tempDir, '.generated');
    const logger = { info: vi.fn() };

    await generateSchema({ workspaceRoot: tempDir, generatedDir, logger });

    // SQLite barrel must exist.
    await expect(access(path.join(generatedDir, 'schema.ts'))).resolves.toBeUndefined();

    // Postgres barrel must NOT exist when only the default sqlite dialect is used.
    await expect(access(path.join(generatedDir, 'schema.postgres.ts'))).rejects.toThrow();
  });

  it('dialects ["sqlite","postgres"] writes both barrels with exact content', async () => {
    tempDir = await createDualDialectWorkspace();
    const pkgRoot = path.join(tempDir, 'services', 'dual');
    const generatedDir = path.join(tempDir, '.generated');
    const logger = { info: vi.fn() };

    await generateSchema({ workspaceRoot: tempDir, generatedDir, dialects: ['sqlite', 'postgres'], logger });

    // SQLite barrel.
    const sqliteContents = await readFile(path.join(generatedDir, 'schema.ts'), 'utf-8');
    expect(sqliteContents).toBe(`export * from '${toPosix(path.resolve(pkgRoot, 'src', 'schema.ts'))}';\n`);

    // Postgres barrel.
    const pgContents = await readFile(path.join(generatedDir, 'schema.postgres.ts'), 'utf-8');
    expect(pgContents).toBe(`export * from '${toPosix(path.resolve(pkgRoot, 'src', 'schema.postgres.ts'))}';\n`);
  });

  it('rejects an explicit empty dialects list without writing any barrels', async () => {
    tempDir = await createTestWorkspace();
    const generatedDir = path.join(tempDir, '.generated');
    const logger = { info: vi.fn() };

    await expect(generateSchema({ workspaceRoot: tempDir, generatedDir, dialects: [], logger })).rejects.toThrow(
      /must contain at least one dialect/,
    );

    // The guard fires before anything is written — not even the output directory exists.
    await expect(access(generatedDir)).rejects.toThrow();
  });

  it('barrels are deterministic across calls with the same workspace', async () => {
    tempDir = await createDualDialectWorkspace();
    const generatedDir = path.join(tempDir, '.generated');
    const logger = { info: vi.fn() };

    await generateSchema({ workspaceRoot: tempDir, generatedDir, dialects: ['sqlite', 'postgres'], logger });
    const firstSqlite = await readFile(path.join(generatedDir, 'schema.ts'), 'utf-8');
    const firstPg = await readFile(path.join(generatedDir, 'schema.postgres.ts'), 'utf-8');

    await generateSchema({ workspaceRoot: tempDir, generatedDir, dialects: ['sqlite', 'postgres'], logger });
    const secondSqlite = await readFile(path.join(generatedDir, 'schema.ts'), 'utf-8');
    const secondPg = await readFile(path.join(generatedDir, 'schema.postgres.ts'), 'utf-8');

    expect(secondSqlite).toBe(firstSqlite);
    expect(secondPg).toBe(firstPg);
  });
});
