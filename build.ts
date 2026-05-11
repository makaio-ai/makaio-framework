/**
 * Unified framework distribution build.
 *
 * Builds all framework packages in three grouped tsdown passes that output
 * directly into `./dist/` matching the `publishConfig.exports` layout.
 *
 * Usage:
 *   tsx build.ts                  (from framework/)
 *   tsx framework/build.ts        (from repo root)
 *
 * Groups:
 *   1. bus    — `@makaio/bus-core` bundles all deps inline (singleton root)
 *   2. core   — 26 packages that externalize framework siblings
 *   3. react  — 3 UI packages that additionally externalize React + handle SCSS
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
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

const FRAMEWORK_ROOT = import.meta.dirname;
const DIST = join(FRAMEWORK_ROOT, 'dist');

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
 *   `packages/contracts/src/adapter/index.ts`
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

process.chdir(FRAMEWORK_ROOT);

try {
  if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true });
  }

  for (const config of configs) {
    const { name, ...tsdownConfig } = config;
    const entryCount = Object.keys(tsdownConfig.entry as Record<string, string>).length;
    const start = performance.now();
    console.info(`\n[build] ${name} — ${entryCount} entries`);

    await build({ ...tsdownConfig, clean: false });

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    console.info(`[build] ${name} done in ${elapsed}s`);
  }
} finally {
  process.chdir(previousCwd);
}

const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
console.info(`\n[build] Framework distribution built in ${totalElapsed}s`);
