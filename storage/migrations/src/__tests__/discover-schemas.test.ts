import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverSchemas } from '../discover-schemas.js';
import {
  createTestWorkspace,
  createDualDialectWorkspace,
  writePostgresWithoutSqlitePackage,
  writeSqliteOnlyPackage,
  writeJson,
  ensureDir,
} from './shared.js';

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('discoverSchemas', () => {
  // ─── Legacy form: backward compatibility ─────────────────────────────────

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

  it('honors negated workspace entries when discovering schemas', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-'));

    await writeJson(path.join(tempDir, 'package.json'), {
      workspaces: ['services/*', '!services/excluded'],
    });

    const includedRoot = path.join(tempDir, 'services', 'included');
    const excludedRoot = path.join(tempDir, 'services', 'excluded');
    await ensureDir(path.join(includedRoot, 'src'));
    await ensureDir(path.join(excludedRoot, 'src'));
    await writeJson(path.join(includedRoot, 'package.json'), {
      name: '@makaio/services-included',
      makaio: { drizzleSchema: './src/schema.ts' },
    });
    await writeJson(path.join(excludedRoot, 'package.json'), {
      name: '@makaio/services-excluded',
      makaio: { drizzleSchema: './src/schema.ts' },
    });
    await writeJson(path.join(includedRoot, 'src', 'schema.ts'), {});
    await writeJson(path.join(excludedRoot, 'src', 'schema.ts'), {});

    await expect(discoverSchemas(tempDir)).resolves.toEqual([
      {
        packageName: '@makaio/services-included',
        schemaPath: path.join(includedRoot, 'src', 'schema.ts'),
      },
    ]);
  });

  it('defaults dialect to sqlite (zero-arg-compatible call sites unchanged)', async () => {
    tempDir = await createTestWorkspace();

    const explicitSqlite = await discoverSchemas(tempDir, undefined, 'sqlite');
    const defaultDialect = await discoverSchemas(tempDir);

    expect(defaultDialect).toEqual(explicitSqlite);
  });

  it('legacy bare-string and array forms are treated as sqlite-only', async () => {
    tempDir = await createTestWorkspace();

    // Both legacy packages appear in the sqlite run.
    const sqliteSchemas = await discoverSchemas(tempDir, undefined, 'sqlite');
    const packageNames = sqliteSchemas.map((s) => s.packageName);
    expect(packageNames).toContain('@makaio/services-alpha');
    expect(packageNames).toContain('@makaio/libs-beta');
  });

  // ─── Object form ─────────────────────────────────────────────────────────

  it('object form: sqlite run returns the sqlite paths', async () => {
    tempDir = await createDualDialectWorkspace();
    const pkgRoot = path.join(tempDir, 'services', 'dual');

    const schemas = await discoverSchemas(tempDir, undefined, 'sqlite');

    expect(schemas).toEqual([
      {
        packageName: '@makaio/services-dual',
        schemaPath: path.resolve(pkgRoot, 'src', 'schema.ts'),
      },
    ]);
  });

  it('object form: postgres run returns the postgres paths', async () => {
    tempDir = await createDualDialectWorkspace();
    const pkgRoot = path.join(tempDir, 'services', 'dual');

    const schemas = await discoverSchemas(tempDir, undefined, 'postgres');

    expect(schemas).toEqual([
      {
        packageName: '@makaio/services-dual',
        schemaPath: path.resolve(pkgRoot, 'src', 'schema.postgres.ts'),
      },
    ]);
  });

  // ─── Declaration error: postgres without sqlite ───────────────────────────

  it('throws on the sqlite run when a package declares postgres entries but no sqlite entries', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-'));
    await writeJson(path.join(tempDir, 'package.json'), { workspaces: ['services/*'] });

    await writePostgresWithoutSqlitePackage(tempDir, 'services/pg-only', '@makaio/pg-only');

    await expect(discoverSchemas(tempDir, undefined, 'sqlite')).rejects.toThrow(
      `Package "@makaio/pg-only" declares makaio.drizzleSchema with 'postgres' entries but no 'sqlite' entries.`,
    );
  });

  it('throws on the postgres run when a package declares postgres entries but no sqlite entries', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-'));
    await writeJson(path.join(tempDir, 'package.json'), { workspaces: ['services/*'] });

    await writePostgresWithoutSqlitePackage(tempDir, 'services/pg-only', '@makaio/pg-only');

    await expect(discoverSchemas(tempDir, undefined, 'postgres')).rejects.toThrow(
      `Package "@makaio/pg-only" declares makaio.drizzleSchema with 'postgres' entries but no 'sqlite' entries.`,
    );
  });

  // ─── Generation-time strictness (postgres run only) ───────────────────────

  it('postgres run throws when a package has sqlite entries but no postgres entries', async () => {
    // Workspace with one dual-dialect package (OK) and one legacy-only package (not OK for postgres).
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-'));
    await writeJson(path.join(tempDir, 'package.json'), { workspaces: ['services/*'] });

    // Add the dual package first (it will pass the postgres check).
    const dualPkgRoot = path.join(tempDir, 'services', 'dual');
    await ensureDir(path.join(dualPkgRoot, 'src'));
    await writeJson(path.join(dualPkgRoot, 'package.json'), {
      name: '@makaio/services-dual',
      makaio: {
        drizzleSchema: {
          sqlite: ['./src/schema.ts'],
          postgres: ['./src/schema.postgres.ts'],
        },
      },
    });
    await writeFile(path.join(dualPkgRoot, 'src', 'schema.ts'), 'export const d = true;\n');
    await writeFile(path.join(dualPkgRoot, 'src', 'schema.postgres.ts'), 'export const dpg = true;\n');

    // Add the legacy-only package (no postgres entries).
    await writeSqliteOnlyPackage(tempDir, 'services/legacy', '@makaio/services-legacy');

    // The postgres run throws naming the legacy package.
    await expect(discoverSchemas(tempDir, undefined, 'postgres')).rejects.toThrow(
      `Package "@makaio/services-legacy" declares makaio.drizzleSchema without a 'postgres' entry.`,
    );

    // The sqlite run succeeds (the legacy package is fine in the sqlite context).
    const sqliteSchemas = await discoverSchemas(tempDir, undefined, 'sqlite');
    const names = sqliteSchemas.map((s) => s.packageName);
    expect(names).toContain('@makaio/services-dual');
    expect(names).toContain('@makaio/services-legacy');
  });

  // ─── Existence-check: both dialect lists always checked ───────────────────

  it('missing postgres twin file fails even the sqlite run', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-migrations-'));
    await writeJson(path.join(tempDir, 'package.json'), { workspaces: ['services/*'] });

    const pkgRoot = path.join(tempDir, 'services', 'partial');
    await ensureDir(path.join(pkgRoot, 'src'));
    await writeJson(path.join(pkgRoot, 'package.json'), {
      name: '@makaio/services-partial',
      makaio: {
        drizzleSchema: {
          sqlite: ['./src/schema.ts'],
          postgres: ['./src/schema.postgres.ts'], // this file will NOT be written
        },
      },
    });
    // Only write the sqlite file; leave the postgres twin missing.
    await writeFile(path.join(pkgRoot, 'src', 'schema.ts'), 'export const x = true;\n');

    await expect(discoverSchemas(tempDir, undefined, 'sqlite')).rejects.toThrow('Schema file not found');
  });

  // ─── Sort order ───────────────────────────────────────────────────────────

  it('returns entries sorted by package name then path for each dialect', async () => {
    tempDir = await createDualDialectWorkspace();

    const sqlite = await discoverSchemas(tempDir, undefined, 'sqlite');
    const postgres = await discoverSchemas(tempDir, undefined, 'postgres');

    // Single-entry results must themselves be sorted (trivial but confirms contract).
    expect(sqlite.map((s) => s.packageName)).toEqual([...sqlite.map((s) => s.packageName)].sort());
    expect(postgres.map((s) => s.packageName)).toEqual([...postgres.map((s) => s.packageName)].sort());
  });
});
