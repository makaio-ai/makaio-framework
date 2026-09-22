import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionDependency } from '@makaio/contracts';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import { runExtensionMigrations, type ExtensionMigrationRunner } from '../extension/extension-migration-runner.js';
import type { ExtensionEntry, KernelMakaioExtension } from '../extension/types.js';

/**
 * Build the minimum coordinator entry required by the migration runner.
 * @param pkg - Extension manifest to wrap.
 * @param enabled - Whether the entry is enabled. Defaults to `true`.
 * @returns Extension entry with discovered state.
 */
function makeEntry(pkg: KernelMakaioExtension, enabled = true): ExtensionEntry {
  return {
    pkg,
    identity: createExtensionIdentity(pkg.name),
    state: 'discovered',
    enabled,
    extensionManaged: true,
    warnings: [],
  };
}

/**
 * Build a minimal required {@link ExtensionDependency} for test fixtures.
 * @param name - Name of the required extension.
 * @returns A minimal structured dependency object.
 */
function dep(name: string): ExtensionDependency {
  return { type: 'extension', name, version: '>=0.1.0' };
}

/**
 * Build an optional structured dependency for test fixtures.
 * @param name - Name of the optional extension.
 * @returns A structured optional dependency object.
 */
function optionalDep(name: string): ExtensionDependency {
  return { ...dep(name), optional: true };
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

  it('excludes a disabled extension from migration sources while its entry stays in loadOrder', async () => {
    const packageRoot = '/workspace/extensions/disabled-extension';
    const runMigrations = vi.fn(async () => {});
    const pkg: KernelMakaioExtension = {
      name: 'disabled-extension',
      displayName: 'Disabled extension',
      version: '0.1.0',
      storage: {
        migrations: 'drizzle',
        packageRoot,
      },
    };

    await runExtensionMigrations({
      loadOrder: [pkg.name],
      entries: new Map([[pkg.name, makeEntry(pkg, false)]]),
      runMigrations,
    });

    // The extension is disabled so its migration must not run — this is the
    // operator's escape hatch for a migration that breaks boot. Its entry
    // remains present (asserted by the loadOrder lookup not throwing), so
    // status and listing still know about it and `setEnabled` remains
    // toggleable for the next restart.
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('excludes an enabled extension whose required dependency is disabled', async () => {
    const runMigrations = vi.fn(async () => {});
    const dependencyPkg: KernelMakaioExtension = {
      name: 'github',
      displayName: 'GitHub',
      version: '0.1.0',
    };
    const dependentPackageRoot = '/workspace/extensions/github-materialization';
    const dependentPkg: KernelMakaioExtension = {
      name: 'github-materialization',
      displayName: 'GitHub materialization',
      version: '0.1.0',
      dependencies: [dep('github')],
      storage: {
        migrations: 'drizzle',
        packageRoot: dependentPackageRoot,
      },
    };

    await runExtensionMigrations({
      loadOrder: [dependencyPkg.name, dependentPkg.name],
      entries: new Map([
        [dependencyPkg.name, makeEntry(dependencyPkg, false)],
        [dependentPkg.name, makeEntry(dependentPkg, true)],
      ]),
      runMigrations,
    });

    // `github-materialization` is preference-enabled, but its required
    // dependency `github` is disabled, so `startExtensionEntry` will never
    // let it reach `active`. Its migration source must not be collected
    // either.
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('excludes an enabled extension whose required dependency is transitively disabled', async () => {
    const runMigrations = vi.fn(async () => {});
    const rootPkg: KernelMakaioExtension = {
      name: 'root-extension',
      displayName: 'Root extension',
      version: '0.1.0',
    };
    const middlePkg: KernelMakaioExtension = {
      name: 'middle-extension',
      displayName: 'Middle extension',
      version: '0.1.0',
      dependencies: [dep('root-extension')],
    };
    const leafPackageRoot = '/workspace/extensions/leaf-extension';
    const leafPkg: KernelMakaioExtension = {
      name: 'leaf-extension',
      displayName: 'Leaf extension',
      version: '0.1.0',
      dependencies: [dep('middle-extension')],
      storage: {
        migrations: 'drizzle',
        packageRoot: leafPackageRoot,
      },
    };

    await runExtensionMigrations({
      loadOrder: [rootPkg.name, middlePkg.name, leafPkg.name],
      entries: new Map([
        [rootPkg.name, makeEntry(rootPkg, false)],
        [middlePkg.name, makeEntry(middlePkg, true)],
        [leafPkg.name, makeEntry(leafPkg, true)],
      ]),
      runMigrations,
    });

    // `middle-extension` is excluded by the direct disable of
    // `root-extension`, which then transitively excludes `leaf-extension`
    // even though `leaf-extension` itself is preference-enabled.
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('collects a migration source for an enabled extension whose disabled dependency is optional', async () => {
    const runMigrations = vi.fn(async () => {});
    const optionalDependencyPkg: KernelMakaioExtension = {
      name: 'optional-dependency',
      displayName: 'Optional dependency',
      version: '0.1.0',
    };
    const packageRoot = '/workspace/extensions/dependent-extension';
    const dependentPkg: KernelMakaioExtension = {
      name: 'dependent-extension',
      displayName: 'Dependent extension',
      version: '0.1.0',
      dependencies: [optionalDep('optional-dependency')],
      storage: {
        migrations: 'drizzle',
        packageRoot,
      },
    };

    await runExtensionMigrations({
      loadOrder: [optionalDependencyPkg.name, dependentPkg.name],
      entries: new Map([
        [optionalDependencyPkg.name, makeEntry(optionalDependencyPkg, false)],
        [dependentPkg.name, makeEntry(dependentPkg, true)],
      ]),
      runMigrations,
    });

    // An optional dependency being disabled must not exclude the dependent
    // extension's migration — only non-optional dependencies participate in
    // the closure.
    const migrationsPath = path.resolve(packageRoot, 'drizzle');
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(runMigrations).toHaveBeenCalledWith([
      {
        name: dependentPkg.name,
        migrationsPath,
        migrationSourceId: migrationsPath,
      },
    ]);
  });

  it('still runs migrations for a mix of enabled and disabled extensions, including only the enabled one', async () => {
    const runMigrations = vi.fn(async () => {});
    const enabledPackageRoot = '/workspace/extensions/enabled-extension';
    const enabledPkg: KernelMakaioExtension = {
      name: 'enabled-extension',
      displayName: 'Enabled extension',
      version: '0.1.0',
      storage: {
        migrations: 'drizzle',
        packageRoot: enabledPackageRoot,
      },
    };
    const disabledPkg: KernelMakaioExtension = {
      name: 'disabled-extension',
      displayName: 'Disabled extension',
      version: '0.1.0',
      storage: {
        migrations: 'drizzle',
        packageRoot: '/workspace/extensions/disabled-extension',
      },
    };

    await runExtensionMigrations({
      loadOrder: [enabledPkg.name, disabledPkg.name],
      entries: new Map([
        [enabledPkg.name, makeEntry(enabledPkg, true)],
        [disabledPkg.name, makeEntry(disabledPkg, false)],
      ]),
      runMigrations,
    });

    const migrationsPath = path.resolve(enabledPackageRoot, 'drizzle');
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(runMigrations).toHaveBeenCalledWith([
      {
        name: enabledPkg.name,
        migrationsPath,
        migrationSourceId: migrationsPath,
      },
    ]);
  });
});
