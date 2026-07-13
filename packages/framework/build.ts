/**
 * Unified framework distribution build.
 *
 * Builds all framework packages in three grouped tsdown passes that output
 * directly into `./dist/` matching the package `exports` layout.
 *
 * Usage:
 *   tsx build.ts                  (from packages/framework/)
 *   tsx packages/framework/build.ts  (from framework workspace root)
 *
 * Groups:
 *   1. bus    — `@makaio/bus-core` bundles all deps inline (singleton root)
 *   2. core   — framework packages that externalize framework siblings
 *   3. react  — 3 UI packages that additionally externalize React + handle SCSS
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type UserConfig } from 'tsdown';
import { FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS } from '@makaio/build-tooling/framework-public-surface';
import {
  frameworkBusPreset,
  frameworkPreset,
  frameworkReactPreset,
} from '@makaio/build-tooling/tsdown-framework-preset';
import { createMakaioScssImporter } from '@makaio/build-tooling/tsdown-scss';
import {
  normalizePackageExports,
  resolvePackageExportSourceTarget,
  type PackageExportsField,
} from '@makaio/build-tooling/package-exports';
import { verifyFrameworkDist } from '../../scripts/lib/framework-dist-verifier.js';
import { copyRuntimeMigrationChain } from '../../scripts/lib/runtime-migration-assets.js';
import { writeFrameworkDistBuildStamp } from './build-fingerprint.js';
import { mergeFrameworkBuildStages } from './build-staging.js';

/** This package's root (`packages/framework/`). Build output lands in `./dist/` here. */
const PACKAGE_DIR = import.meta.dirname;

/** Framework workspace root — source packages are resolved relative to this. */
const FRAMEWORK_ROOT = resolve(PACKAGE_DIR, '..', '..');

const DIST = join(PACKAGE_DIR, 'dist');

/** Runtime-only distribution — `dist/` minus type declarations (`.d.mts`). */
const LIB = join(PACKAGE_DIR, 'lib');

const BUS_PACKAGES = new Set(['@makaio/bus-core']);
const REACT_PACKAGES = new Set(['@makaio/ui-hooks', '@makaio/ui-components', '@makaio/ui-views']);

// ---------------------------------------------------------------------------
// Entry-map generation
// ---------------------------------------------------------------------------

/**
 * Read a workspace package.json and extract source entry points from its
 * `exports` field.
 * @param packageRoot - Package root relative to the framework directory.
 * @returns Map of export subpath to source file path.
 */
function readPackageEntries(packageRoot: string): Record<string, string> {
  const pkgPath = join(FRAMEWORK_ROOT, packageRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    exports?: PackageExportsField;
  };

  if (!pkg.exports) return {};

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalizePackageExports(pkg.exports))) {
    if (key === './package.json') continue;
    const sourcePath = resolvePackageExportSourceTarget(value);
    if (!sourcePath) continue;
    entries[key] = sourcePath;
  }
  return entries;
}

/**
 * Build the tsdown entry object for a set of framework packages.
 *
 * Maps each package export to a framework dist output path:
 *   `core/contracts/src/adapter/index.ts`
 *     entry key `contracts/adapter/index`
 *     output `dist/contracts/adapter/index.mjs` + `.d.mts`
 * @param packages - Framework packages to include.
 * @returns Entry map keyed by output path stem.
 */
function buildEntryMap(
  packages: ReadonlyArray<(typeof FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS)[number]>,
): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const pkg of packages) {
    const pkgEntries = readPackageEntries(pkg.packageRoot);
    if (Object.keys(pkgEntries).length === 0) {
      throw new Error(`No buildable exports found for ${pkg.packageName} (${pkg.packageRoot})`);
    }

    for (const [, sourcePath] of Object.entries(pkgEntries)) {
      const relOutput = sourcePath.replace(/^\.\/src\//, '').replace(/\.(?:ts|tsx|mts|cts)$/, '');
      const outputKey = `${pkg.frameworkSubpath}/${relOutput}`;
      entries[outputKey] = `./${pkg.packageRoot}/${sourcePath.replace(/^\.\//, '')}`;
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Package grouping
// ---------------------------------------------------------------------------

const busPackages = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.filter((p) => BUS_PACKAGES.has(p.packageName));
const reactPackages = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.filter((p) => REACT_PACKAGES.has(p.packageName));
const standardPackages = FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.filter(
  (p) => !BUS_PACKAGES.has(p.packageName) && !REACT_PACKAGES.has(p.packageName),
);

// ---------------------------------------------------------------------------
// Build configs
// ---------------------------------------------------------------------------

const configs: Array<UserConfig & { name: string }> = [
  {
    name: 'bus',
    ...frameworkBusPreset,
    entry: buildEntryMap(busPackages),
    outDir: DIST,
  },
  {
    name: 'core',
    ...frameworkPreset,
    entry: buildEntryMap(standardPackages),
    outDir: DIST,
  },
  {
    name: 'react',
    ...frameworkReactPreset,
    entry: buildEntryMap(reactPackages),
    outDir: DIST,
    css: {
      preprocessorOptions: {
        scss: {
          loadPaths: [resolve(FRAMEWORK_ROOT, 'node_modules')],
          importers: [createMakaioScssImporter(FRAMEWORK_ROOT)],
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Build execution
// ---------------------------------------------------------------------------

const totalStart = performance.now();
const previousCwd = process.cwd();
const stageRoot = mkdtempSync(join(PACKAGE_DIR, '.build-stages-'));
const completedStages: Array<{ name: string; path: string }> = [];

process.chdir(FRAMEWORK_ROOT);

try {
  if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true });
  }

  for (const config of configs) {
    const { name, ...tsdownConfig } = config;
    const stageDir = join(stageRoot, name);
    const entryCount = Object.keys(tsdownConfig.entry as Record<string, string>).length;
    const start = performance.now();
    console.info(`\n[build] ${name} — ${entryCount} entries`);

    await build({ ...tsdownConfig, outDir: stageDir });
    completedStages.push({ name, path: stageDir });

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    console.info(`[build] ${name} done in ${elapsed}s`);
  }

  mergeFrameworkBuildStages(completedStages, DIST);
} finally {
  process.chdir(previousCwd);
  rmSync(stageRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Copy runtime assets into dist/
// ---------------------------------------------------------------------------

// Central drizzle migrations (SQLite chain) — consumed at boot via
// `CoreBootOptions.centralMigrationsDir` (and the bundled default
// `dist/runtime-node/../drizzle` lookup). The Postgres chain ships with
// `@makaio/storage-pg`, whose engine resolves it through
// `StorageEngine.migrations.resolveSourceChainDir`.
copyRuntimeMigrationChain(join(FRAMEWORK_ROOT, 'storage', 'migrations', 'drizzle'), join(DIST, 'drizzle'));

// ---------------------------------------------------------------------------
// Assemble runtime-only lib/ (dist/ minus type declarations)
// ---------------------------------------------------------------------------

if (existsSync(LIB)) {
  rmSync(LIB, { recursive: true });
}

cpSync(DIST, LIB, {
  recursive: true,
  filter: (src) => !src.endsWith('.d.mts'),
});

// Minimal manifest so the bundled runtime can resolve its own version via
// `readFrameworkVersion` (`dist/runtime-node/../package.json`). Intentionally
// not a full package.json copy to avoid a second exports map inside dist/,
// and written after the lib/ assembly so lib/ stays manifest-free. Every
// enclosing workspace root excludes this directory from its `workspaces`
// globs (`!…packages/framework/dist`), so the manifest is not picked up as a
// duplicate @makaio/framework workspace regardless of repository layout.
const frameworkPkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
writeFileSync(
  join(DIST, 'package.json'),
  `${JSON.stringify({ name: frameworkPkg.name, version: frameworkPkg.version, type: 'module' }, null, 2)}\n`,
  'utf8',
);

writeFrameworkDistBuildStamp();

// ---------------------------------------------------------------------------
// Verify the assembled distribution
// ---------------------------------------------------------------------------

// Fail the build when an exports-map target is missing, a built module
// self-imports a subpath the exports map does not expose, a built module
// imports a bare external the manifest does not declare, or a bundled
// migration chain is missing or inconsistent. These defects only surface at
// a consumer's boot otherwise.
const verification = verifyFrameworkDist(PACKAGE_DIR);
if (!verification.ok) {
  console.error('[build] framework distribution verification failed:');
  for (const issue of verification.issues) {
    console.error(`  [${issue.kind}] ${issue.message}`);
  }
  process.exit(1);
}
console.info(
  `[build] distribution verified (${verification.checkedTargets} export targets, ${verification.scannedModules} modules scanned, migration chains ok)`,
);

const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
console.info(`\n[build] Framework distribution built in ${totalElapsed}s`);
