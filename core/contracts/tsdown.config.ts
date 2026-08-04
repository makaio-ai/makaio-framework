import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { defineConfig } from 'tsdown';
import {
  normalizePackageExports,
  resolvePackageExportSourceTarget,
  type PackageExportValue,
  type PackageExportsField,
} from '@makaio/build-tooling/package-exports';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

interface ContractsPackageManifest {
  exports?: PackageExportsField;
  publishConfig?: {
    exports?: PackageExportsField;
  };
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'),
) as ContractsPackageManifest;

// The package manifest is the public-surface source of truth. Deriving tsdown
// entries here prevents a newly published subpath from shipping declarations
// without its corresponding JavaScript entrypoint.
const entries = resolvePublishBuildEntries(manifest, import.meta.dirname);

export default defineConfig({
  ...frameworkPreset,
  dts: false,
  entry: entries,
});

/**
 * Derive and validate JavaScript build entries from a package manifest.
 * @param packageManifest - Source and publish export declarations.
 * @param packageDirectory - Directory containing the package sources.
 * @returns Build entries keyed by their published runtime paths.
 */
export function resolvePublishBuildEntries(
  packageManifest: ContractsPackageManifest,
  packageDirectory: string,
): Record<string, string> {
  const sourceExports = normalizePackageExports(packageManifest.exports);
  const publishExports = normalizePackageExports(packageManifest.publishConfig?.exports);
  const resolvedEntries = new Map<string, string>();

  for (const [exportKey, sourceExport] of Object.entries(sourceExports)) {
    if (exportKey === './package.json') continue;

    const sourceTarget = resolvePackageExportSourceTarget(sourceExport);
    if (!sourceTarget) {
      throw new Error(`@makaio/contracts export "${exportKey}" has no buildable source target`);
    }
    if (!existsSync(join(packageDirectory, sourceTarget))) {
      throw new Error(`@makaio/contracts export "${exportKey}" has no buildable source file: ${sourceTarget}`);
    }

    const entryName = resolvePublishEntryName(exportKey, publishExports[exportKey]);
    if (resolvedEntries.has(entryName)) {
      throw new Error(`@makaio/contracts export "${exportKey}" duplicates build entry "${entryName}"`);
    }
    resolvedEntries.set(entryName, sourceTarget);
  }

  for (const exportKey of Object.keys(publishExports)) {
    if (exportKey === './package.json') continue;
    if (!Object.hasOwn(sourceExports, exportKey)) {
      throw new Error(`@makaio/contracts published export "${exportKey}" has no matching source export`);
    }
  }

  if (resolvedEntries.size === 0) {
    throw new Error('@makaio/contracts has no buildable source exports');
  }

  return Object.fromEntries(resolvedEntries);
}

/**
 * Resolve the normalized tsdown entry name for a published JavaScript target.
 *
 * The target also defines the tsdown entry name, so source aliases and their
 * published runtime locations cannot silently diverge.
 * @param exportKey - Public package export key being validated.
 * @param publishExport - Matching publish-time export declaration.
 * @returns Entry name relative to the `dist` output directory.
 */
export function resolvePublishEntryName(exportKey: string, publishExport: PackageExportValue | undefined): string {
  const runtimeTarget = typeof publishExport === 'object' ? publishExport.default : undefined;
  if (typeof runtimeTarget !== 'string' || !runtimeTarget.startsWith('./dist/') || !runtimeTarget.endsWith('.mjs')) {
    throw new Error(
      `@makaio/contracts export "${exportKey}" must declare publishConfig.exports.default under ./dist ending in .mjs`,
    );
  }

  const relativeTarget = runtimeTarget.slice('./dist/'.length);
  const entryName = relativeTarget.slice(0, -'.mjs'.length);
  if (
    entryName.length === 0 ||
    relativeTarget.includes('%') ||
    relativeTarget.includes('\\') ||
    posix.normalize(relativeTarget) !== relativeTarget ||
    relativeTarget.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0)
  ) {
    throw new Error(`@makaio/contracts export "${exportKey}" has an invalid published runtime path: ${runtimeTarget}`);
  }
  return entryName;
}
