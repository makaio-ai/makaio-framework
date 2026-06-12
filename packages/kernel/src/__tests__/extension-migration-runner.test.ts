import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import { runExtensionMigrations, type ExtensionMigrationRunner } from '../extension/extension-migration-runner.js';
import type { ExtensionEntry, KernelMakaioExtension } from '../extension/types.js';

/**
 * Build the minimum coordinator entry required by the migration runner.
 * @param pkg - Extension manifest to wrap.
 * @returns Extension entry with discovered state.
 */
function makeEntry(pkg: KernelMakaioExtension): ExtensionEntry {
  return {
    pkg,
    identity: createExtensionIdentity(pkg.name),
    state: 'discovered',
    enabled: true,
    warnings: [],
  };
}

describe('runExtensionMigrations', () => {
  it('throws when loadOrder references an entry that is not loaded', async () => {
    await expect(
      runExtensionMigrations({
        loadOrder: ['missing-extension'],
        entries: new Map(),
        runMigrations: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/loadOrder.*missing from entries/);
  });

  it('rejects relative migration paths that escape storage.packageRoot', async () => {
    const runMigrations = vi.fn(async () => {});
    const pkg: KernelMakaioExtension = {
      name: 'escaping-extension',
      displayName: 'Escaping extension',
      version: '0.1.0',
      storage: {
        migrations: '../shared/drizzle',
        packageRoot: '/workspace/extensions/escaping-extension',
      },
    };

    await expect(
      runExtensionMigrations({
        loadOrder: [pkg.name],
        entries: new Map([[pkg.name, makeEntry(pkg)]]),
        runMigrations,
      }),
    ).rejects.toThrow(/storage\.migrations.*outside storage\.packageRoot/);
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('resolves both per-dialect chains from the object form and prefers sqlite for the singular path', async () => {
    const packageRoot = '/workspace/extensions/dual-extension';
    const runMigrations = vi.fn(async () => {});
    const pkg: KernelMakaioExtension = {
      name: 'dual-extension',
      displayName: 'Dual extension',
      version: '0.1.0',
      storage: {
        migrations: { sqlite: 'drizzle', postgres: 'drizzle-postgres' },
        packageRoot,
      },
    };

    await runExtensionMigrations({
      loadOrder: [pkg.name],
      entries: new Map([[pkg.name, makeEntry(pkg)]]),
      runMigrations,
    });

    const sqlitePath = path.resolve(packageRoot, 'drizzle');
    const postgresPath = path.resolve(packageRoot, 'drizzle-postgres');
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(runMigrations).toHaveBeenCalledWith([
      {
        name: 'dual-extension',
        migrationsPath: sqlitePath,
        migrationSourceId: sqlitePath,
        migrationsPathByDialect: { sqlite: sqlitePath, postgres: postgresPath },
      },
    ]);
  });

  it('uses the only declared entry as the singular path for a partial object form', async () => {
    const packageRoot = '/workspace/extensions/pg-only-extension';
    const runMigrations = vi.fn(async () => {});
    const pkg: KernelMakaioExtension = {
      name: 'pg-only-extension',
      displayName: 'Postgres-only extension',
      version: '0.1.0',
      storage: {
        migrations: { postgres: 'drizzle-postgres' },
        packageRoot,
      },
    };

    await runExtensionMigrations({
      loadOrder: [pkg.name],
      entries: new Map([[pkg.name, makeEntry(pkg)]]),
      runMigrations,
    });

    const postgresPath = path.resolve(packageRoot, 'drizzle-postgres');
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(runMigrations).toHaveBeenCalledWith([
      {
        name: 'pg-only-extension',
        migrationsPath: postgresPath,
        migrationSourceId: postgresPath,
        migrationsPathByDialect: { postgres: postgresPath },
      },
    ]);
  });

  it('omits migrationsPathByDialect for the bare-string form', async () => {
    const packageRoot = '/workspace/extensions/legacy-extension';
    const runMigrations = vi.fn<ExtensionMigrationRunner>(async () => {});
    const pkg: KernelMakaioExtension = {
      name: 'legacy-extension',
      displayName: 'Legacy extension',
      version: '0.1.0',
      storage: {
        migrations: 'drizzle',
        packageRoot,
      },
    };

    await runExtensionMigrations({
      loadOrder: [pkg.name],
      entries: new Map([[pkg.name, makeEntry(pkg)]]),
      runMigrations,
    });

    const migrationsPath = path.resolve(packageRoot, 'drizzle');
    expect(runMigrations).toHaveBeenCalledTimes(1);
    const sources = runMigrations.mock.calls[0]?.[0];
    expect(sources).toEqual([
      {
        name: 'legacy-extension',
        migrationsPath,
        migrationSourceId: migrationsPath,
      },
    ]);
    expect(sources?.[0]).not.toHaveProperty('migrationsPathByDialect');
  });

  it('rejects an object form whose per-dialect value escapes storage.packageRoot', async () => {
    const runMigrations = vi.fn(async () => {});
    const pkg: KernelMakaioExtension = {
      name: 'escaping-dialect-extension',
      displayName: 'Escaping dialect extension',
      version: '0.1.0',
      storage: {
        migrations: { postgres: '../x' },
        packageRoot: '/workspace/extensions/escaping-dialect-extension',
      },
    };

    await expect(
      runExtensionMigrations({
        loadOrder: [pkg.name],
        entries: new Map([[pkg.name, makeEntry(pkg)]]),
        runMigrations,
      }),
    ).rejects.toThrow(/storage\.migrations.*outside storage\.packageRoot/);
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('skips an empty object form and never calls runMigrations', async () => {
    const runMigrations = vi.fn(async () => {});
    const pkg: KernelMakaioExtension = {
      name: 'empty-object-extension',
      displayName: 'Empty object extension',
      version: '0.1.0',
      storage: {
        migrations: {},
        packageRoot: '/workspace/extensions/empty-object-extension',
      },
    };

    await runExtensionMigrations({
      loadOrder: [pkg.name],
      entries: new Map([[pkg.name, makeEntry(pkg)]]),
      runMigrations,
    });

    expect(runMigrations).not.toHaveBeenCalled();
  });
});
