import path from 'node:path';
import { primaryMigrationsPath, type StorageDialect } from '@makaio/contracts';
import type { ExtensionEntry, KernelMakaioExtension } from './types.js';

/** Extension migration source passed from the coordinator to the host runtime. */
export interface ExtensionMigrationSource {
  /** Extension name used for diagnostics. */
  readonly name: string;
  /** Absolute path to the extension migration directory. */
  readonly migrationsPath: string;
  /** Stable identity for the migration bundle. */
  readonly migrationSourceId: string;
  /** Optional per-dialect chains, mirroring the extension `storage.migrations` object form; resolved to absolute paths. Empty when the manifest declared a bare-string chain. */
  readonly migrationsPathByDialect?: Partial<Record<StorageDialect, string>>;
}

/** Host callback that applies extension-declared migrations. */
export type ExtensionMigrationRunner = (sources: ReadonlyArray<ExtensionMigrationSource>) => Promise<void>;

/**
 * Collect migration sources in dependency order and invoke the host callback.
 * @param options - Coordinator state and host migration callback.
 */
export async function runExtensionMigrations(options: {
  readonly loadOrder: readonly string[];
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  readonly runMigrations: ExtensionMigrationRunner | undefined;
}): Promise<void> {
  if (!options.runMigrations) return;

  const sources: ExtensionMigrationSource[] = [];
  for (const name of options.loadOrder) {
    const entry = options.entries.get(name);
    if (!entry) {
      throw new Error(`Extension "${name}" is in loadOrder but missing from entries`);
    }
    const migrations = entry.pkg.storage?.migrations;
    if (!migrations) continue;

    let migrationsPath: string;
    let migrationsPathByDialect: Partial<Record<StorageDialect, string>> | undefined;
    if (typeof migrations === 'string') {
      migrationsPath = resolveMigrationPath(name, entry.pkg, migrations);
    } else {
      // Object form: resolve and containment-check every declared per-dialect
      // path. The coordinator stays dialect-agnostic — the host runtime selects
      // the active dialect's chain from the map at apply time.
      const resolved: Partial<Record<StorageDialect, string>> = {};
      for (const [dialect, value] of Object.entries(migrations) as [StorageDialect, string | undefined][]) {
        if (value === undefined) continue;
        resolved[dialect] = resolveMigrationPath(name, entry.pkg, value);
      }
      // Keep the singular path populated so the runtime fallback
      // (`migrationsPathByDialect?.[dialect] ?? migrationsPath`) always has a
      // real chain. `primaryMigrationsPath` applies the same precedence on the
      // resolved map as on the raw manifest: prefer sqlite, else the first
      // declared entry. An empty object yields `undefined` — nothing to apply.
      const primary = primaryMigrationsPath(resolved);
      if (primary === undefined) continue;
      migrationsPath = primary;
      migrationsPathByDialect = resolved;
    }

    sources.push({
      name,
      migrationsPath,
      migrationSourceId: entry.pkg.storage?.migrationSourceId ?? migrationsPath,
      ...(migrationsPathByDialect ? { migrationsPathByDialect } : {}),
    });
  }

  if (sources.length === 0) return;
  await options.runMigrations(sources);
}

/**
 * Resolve an extension migration folder to an absolute path.
 * @param name - Extension name for error reporting.
 * @param pkg - Extension manifest declaring the migration folder.
 * @param migrationsPath - Raw path from {@link StorageManifest.migrations}.
 * @returns Absolute migrations folder path.
 */
function resolveMigrationPath(name: string, pkg: KernelMakaioExtension, migrationsPath: string): string {
  if (path.isAbsolute(migrationsPath)) {
    return migrationsPath;
  }

  const packageRoot = pkg.storage?.packageRoot;
  if (!packageRoot) {
    throw new Error(
      `Extension "${name}" declares relative storage.migrations "${migrationsPath}" without storage.packageRoot`,
    );
  }

  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolved = path.resolve(resolvedPackageRoot, migrationsPath);
  const relative = path.relative(resolvedPackageRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Extension "${name}" declares storage.migrations "${migrationsPath}" outside storage.packageRoot`);
  }

  return resolved;
}
