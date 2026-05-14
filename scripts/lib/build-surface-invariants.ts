/**
 * Build surface invariant checker for the `@makaio/framework` umbrella package.
 *
 * Validates that the three sources of truth — `FRAMEWORK_BUILD_PACKAGE_NAMES`,
 * `FRAMEWORK_DIST_SUBPATHS`, and `packages/framework/package.json exports` —
 * remain consistent as the workspace grows.
 * @packageDocumentation
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FRAMEWORK_BUILD_PACKAGE_NAMES,
  FRAMEWORK_DIST_SUBPATHS,
} from '../../build-tooling/framework-public-surface.js';
import {
  normalizePackageExports,
  resolvePackageExportSourceTarget,
  type PackageExportsField,
} from '../../build-tooling/package-exports.js';

/** A validated finding from the invariant checker. */
export interface SurfaceIssue {
  readonly kind:
    | 'missing-workspace'
    | 'dist-subpath-not-in-umbrella'
    | 'umbrella-export-not-rooted-in-subpath'
    | 'source-export-missing-from-publishconfig';
  readonly message: string;
}

/** Result returned by {@link checkBuildSurface}. */
export interface BuildSurfaceResult {
  readonly issues: readonly SurfaceIssue[];
  readonly ok: boolean;
}

type ExportValue = string | Readonly<Record<string, unknown>>;
type ExportMap = Record<string, ExportValue>;

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  exports?: PackageExportsField;
  publishConfig?: {
    exports?: PackageExportsField;
  };
}

/**
 * Recursively finds all `package.json` files under `dir`, skipping `node_modules`.
 * @param dir - Root directory to search.
 * @returns Absolute paths to each discovered `package.json`.
 */
function findPackageJsonFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPackageJsonFiles(fullPath));
    } else if (entry.name === 'package.json') {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Reads and parses a JSON file.
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed content.
 */
function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Returns the export keys from a source-level `exports` field that require
 * a corresponding `publishConfig.exports` entry.
 *
 * Skips `./package.json`, CSS assets, and non-TypeScript source entries.
 * @param sourceExports - The `exports` map from a workspace package.json.
 * @returns Filtered export keys.
 */
function filterBuildableExportKeys(sourceExports: ExportMap): string[] {
  return Object.entries(sourceExports)
    .filter(([key, value]) => {
      if (key === './package.json') return false;
      return resolvePackageExportSourceTarget(value) !== undefined;
    })
    .map(([key]) => key);
}

/**
 * Returns the known dist subpath roots derived from {@link FRAMEWORK_DIST_SUBPATHS}.
 *
 * Each root is expressed as the `./dist/<subpath>` prefix that umbrella export
 * targets must start with to be considered rooted.
 * @returns Set of known dist roots (e.g. `./dist/bus`, `./dist/services`).
 */
function knownDistRoots(): Set<string> {
  return new Set(FRAMEWORK_DIST_SUBPATHS.map((e) => `./dist/${e.subpath}`));
}

/**
 * Collects all file target strings from an export map value.
 * @param value - Single export entry value.
 * @returns All declared runtime and declaration file paths.
 */
function exportTargets(value: ExportValue): string[] {
  if (typeof value === 'string') return [value];
  return [value.default, value.import, value.require, value.types].filter((t): t is string => typeof t === 'string');
}

/**
 * Checks which `FRAMEWORK_BUILD_PACKAGE_NAMES` entries are absent from the
 * discovered workspace map and pushes missing-workspace issues.
 * @param workspaceByName - Map of package name to manifest path.
 * @param issues - Mutable issues array to push into.
 */
function checkMissingWorkspaces(workspaceByName: Map<string, string>, issues: SurfaceIssue[]): void {
  for (const packageName of FRAMEWORK_BUILD_PACKAGE_NAMES) {
    if (!workspaceByName.has(packageName)) {
      issues.push({
        kind: 'missing-workspace',
        message: `FRAMEWORK_BUILD_PACKAGE_NAMES entry "${packageName}" does not resolve to any workspace package.json`,
      });
    }
  }
}

/**
 * For every tsdown-based workspace package, verifies that each buildable
 * source export key has a matching `publishConfig.exports` entry.
 * @param manifests - Already-parsed workspace manifests keyed by path.
 * @param issues - Mutable issues array to push into.
 */
function checkTsdownPublishConfigParity(manifests: ReadonlyMap<string, PackageManifest>, issues: SurfaceIssue[]): void {
  for (const [manifestPath, manifest] of manifests) {
    if (manifest.scripts?.['build'] !== 'tsdown') continue;
    if (!manifest.exports || !manifest.publishConfig?.exports) continue;

    const sourceKeys = filterBuildableExportKeys(normalizePackageExports(manifest.exports));
    const publishKeys = new Set(Object.keys(normalizePackageExports(manifest.publishConfig.exports)));

    for (const key of sourceKeys) {
      if (!publishKeys.has(key)) {
        issues.push({
          kind: 'source-export-missing-from-publishconfig',
          message: `Package "${manifest.name ?? manifestPath}" has source export "${key}" with no matching publishConfig.exports entry`,
        });
      }
    }
  }
}

/**
 * Verifies every `FRAMEWORK_DIST_SUBPATHS` entry has a corresponding key in
 * the `@makaio/framework` package exports.
 * @param umbrellaExportKeys - Set of keys from `packages/framework/package.json` exports.
 * @param issues - Mutable issues array to push into.
 */
function checkDistSubpathsInUmbrella(umbrellaExportKeys: Set<string>, issues: SurfaceIssue[]): void {
  for (const entry of FRAMEWORK_DIST_SUBPATHS) {
    if (!umbrellaExportKeys.has(`./${entry.subpath}`)) {
      issues.push({
        kind: 'dist-subpath-not-in-umbrella',
        message: `FRAMEWORK_DIST_SUBPATHS entry "./${entry.subpath}" (${entry.packageName}) has no matching exports key in packages/framework/package.json`,
      });
    }
  }
}

/**
 * Verifies every `./dist/...` target in the umbrella exports is rooted under
 * a known dist subpath from `FRAMEWORK_DIST_SUBPATHS`.
 * @param umbrellaExports - The full `@makaio/framework` package exports map.
 * @param issues - Mutable issues array to push into.
 */
function checkUmbrellaExportRoots(umbrellaExports: ExportMap, issues: SurfaceIssue[]): void {
  const roots = knownDistRoots();
  for (const [exportKey, exportValue] of Object.entries(umbrellaExports)) {
    if (exportKey === './package.json') continue;
    for (const target of exportTargets(exportValue)) {
      if (!target.startsWith('./dist/')) continue;
      const isRooted = [...roots].some((root) => target.startsWith(`${root}/`) || target === root);
      if (!isRooted) {
        issues.push({
          kind: 'umbrella-export-not-rooted-in-subpath',
          message: `Umbrella export "${exportKey}" → "${target}" is not rooted under any known FRAMEWORK_DIST_SUBPATHS entry`,
        });
      }
    }
  }
}

/**
 * Checks all build surface invariants and returns a structured result.
 *
 * The following invariants are verified:
 * 1. Every `FRAMEWORK_BUILD_PACKAGE_NAMES` entry corresponds to a discovered workspace.
 * 2. For tsdown-based packages, every buildable source export key has a matching
 *    `publishConfig.exports` entry.
 * 3. Every `FRAMEWORK_DIST_SUBPATHS` entry has a corresponding export root in
 *    the `@makaio/framework` package exports.
 * 4. Every `./dist/...` entry in the umbrella exports is rooted under a known
 *    dist subpath from `FRAMEWORK_DIST_SUBPATHS`.
 * @param frameworkRoot - Absolute path to the framework workspace root.
 * @returns Structured result with all discovered issues.
 */
export function checkBuildSurface(frameworkRoot: string): BuildSurfaceResult {
  const issues: SurfaceIssue[] = [];

  const workspaceManifestPaths = findPackageJsonFiles(frameworkRoot).filter(
    (p) => p !== join(frameworkRoot, 'package.json'),
  );

  const workspaceByName = new Map<string, string>();
  const manifestsByPath = new Map<string, PackageManifest>();
  for (const manifestPath of workspaceManifestPaths) {
    const manifest = readJson(manifestPath) as PackageManifest;
    manifestsByPath.set(manifestPath, manifest);
    if (manifest.name) {
      workspaceByName.set(manifest.name, manifestPath);
    }
  }

  checkMissingWorkspaces(workspaceByName, issues);
  checkTsdownPublishConfigParity(manifestsByPath, issues);

  const umbrellaManifestPath = join(frameworkRoot, 'packages', 'framework', 'package.json');
  const umbrellaManifest =
    manifestsByPath.get(umbrellaManifestPath) ?? (readJson(umbrellaManifestPath) as PackageManifest);
  const umbrellaExports = normalizePackageExports(umbrellaManifest.exports);
  const umbrellaExportKeys = new Set(Object.keys(umbrellaExports));

  checkDistSubpathsInUmbrella(umbrellaExportKeys, issues);
  checkUmbrellaExportRoots(umbrellaExports, issues);

  return { issues, ok: issues.length === 0 };
}
