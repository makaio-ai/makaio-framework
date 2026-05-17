/**
 * Portable package helper for transforming workspace package manifests into
 * publishable npm manifests.
 *
 * Used during the CI publish step to produce a dist-ready `package.json` for
 * each standalone adapter package without modifying the source manifest.
 * @packageDocumentation
 */

import { FRAMEWORK_BUILD_PACKAGE_NAMES } from './framework-public-surface.js';

/**
 * Options for the portable package transform.
 */
export interface PortablePackageOptions {
  /** The exact version string of the framework release (e.g. `'0.1.0'`). */
  readonly frameworkVersion: string;
  /**
   * Override for the `@makaio/framework` peer dependency range.
   * Defaults to `^<frameworkVersion>`.
   */
  readonly frameworkPeerRange?: string;
  /**
   * The set of workspace package names treated as framework-owned.
   * Any of these that appear in `dependencies` as `workspace:*` references
   * are moved to `devDependencies`.
   * Defaults to {@link FRAMEWORK_BUILD_PACKAGE_NAMES}.
   */
  readonly frameworkOwnedPackages?: readonly string[];
}

/**
 * A loose structural type describing a `package.json` object.
 *
 * All fields are readonly to enforce that callers treat the source manifest
 * as immutable. The transform returns a fresh object.
 */
export interface PackageJsonLike {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: {
    readonly main?: string;
    readonly types?: string;
    readonly exports?: unknown;
  } & Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface PublishRootEntrypoints {
  readonly main?: string;
  readonly types?: string;
}

/**
 * Determine whether a workspace dependency is bundled into adapter output.
 * @param packageName - Dependency package name.
 * @param version - Dependency version range from the source manifest.
 * @param frameworkOwnedPackages - Explicit package set owned by the framework distribution.
 * @returns Whether the dependency should be dev-only in the portable manifest.
 */
function isBundledWorkspaceDependency(
  packageName: string,
  version: string | undefined,
  frameworkOwnedPackages: ReadonlySet<string>,
): boolean {
  return (
    version?.startsWith('workspace:') === true &&
    (packageName.startsWith('@makaio/') || frameworkOwnedPackages.has(packageName))
  );
}

/**
 * Derive the declaration-file target for a JavaScript export target.
 * @param target - JavaScript export target from `publishConfig.exports`.
 * @returns Matching declaration-file target.
 */
function toTypesExportTarget(target: string): string {
  return target
    .replace(/\.mjs$/, '.d.mts')
    .replace(/\.cjs$/, '.d.cts')
    .replace(/\.js$/, '.d.ts');
}

/**
 * Remove the package-relative `./` prefix from a manifest path.
 * @param target - Package manifest path.
 * @returns Path without a leading package-relative prefix.
 */
function stripPackageRelativePrefix(target: string): string {
  return target.replace(/^\.\//, '');
}

/**
 * Ensure a package export target is package-relative.
 * @param target - Package manifest path.
 * @returns Path with a leading package-relative prefix.
 */
function ensurePackageRelativePrefix(target: string): string {
  return target.startsWith('./') ? target : `./${target}`;
}

/**
 * Build a root-only export map from resolved publishable entrypoints.
 * @param sourceExports - Source manifest export map.
 * @param rootEntrypoints - Resolved publishable root entrypoints.
 * @returns Export map aligned with portable main/types fields.
 */
function createRootPortableExports(
  sourceExports: Readonly<Record<string, string | { source?: string }>>,
  rootEntrypoints: PublishRootEntrypoints,
): Record<string, unknown> {
  return {
    '.': {
      types: ensurePackageRelativePrefix(rootEntrypoints.types ?? 'dist/index.d.ts'),
      default: ensurePackageRelativePrefix(rootEntrypoints.main ?? 'dist/index.js'),
    },
    ...(sourceExports['./package.json'] ? { './package.json': sourceExports['./package.json'] } : {}),
  };
}

/**
 * Resolve the publish-time root JavaScript export, when declared as a string.
 * @param packageJson - Source workspace package manifest.
 * @returns Root export target from publishConfig, when present.
 */
function getPublishRootExportTarget(packageJson: PackageJsonLike): PublishRootEntrypoints {
  const publishExports = packageJson.publishConfig?.exports;
  if (!publishExports || typeof publishExports !== 'object') return {};

  const rootExport = (publishExports as Record<string, unknown>)['.'];
  if (typeof rootExport === 'string') {
    return { main: rootExport, types: toTypesExportTarget(rootExport) };
  }
  if (!rootExport || typeof rootExport !== 'object') return {};

  const root = rootExport as Record<string, unknown>;
  const main =
    (typeof root.default === 'string' ? root.default : undefined) ??
    (typeof root.import === 'string' ? root.import : undefined) ??
    (typeof root.require === 'string' ? root.require : undefined);
  const types = typeof root.types === 'string' ? root.types : undefined;

  return { main, types };
}

/**
 * Check whether a package manifest declares a root export.
 * @param packageJson - Source workspace package manifest.
 * @returns Whether the source manifest has a root-level runtime entrypoint.
 */
function hasRootExport(packageJson: PackageJsonLike): boolean {
  const exportsField = packageJson.exports;
  if (typeof exportsField === 'string') return true;
  if (!exportsField || typeof exportsField !== 'object') return false;
  return Object.hasOwn(exportsField, '.');
}

/**
 * Resolve root-level `main` and `types` fields for a portable manifest.
 * @param packageJson - Source workspace package manifest.
 * @returns Root entrypoints that should be present in the publish manifest.
 */
function resolvePortableRootEntrypoints(packageJson: PackageJsonLike): PublishRootEntrypoints {
  const publishRootExport = getPublishRootExportTarget(packageJson);
  const sourceHasRootExport = hasRootExport(packageJson);
  const main =
    packageJson.publishConfig?.main ??
    (publishRootExport.main ? stripPackageRelativePrefix(publishRootExport.main) : undefined) ??
    (sourceHasRootExport ? 'dist/index.js' : undefined);
  const types =
    packageJson.publishConfig?.types ??
    (publishRootExport.types ? stripPackageRelativePrefix(publishRootExport.types) : undefined) ??
    (!packageJson.publishConfig?.exports && sourceHasRootExport ? 'dist/index.d.ts' : undefined);

  return { main, types };
}

/**
 * Move bundled framework workspace dependencies out of runtime dependencies.
 * @param dependencies - Mutable runtime dependency map for the portable manifest.
 * @param devDependencies - Mutable development dependency map for the portable manifest.
 * @param frameworkOwnedPackages - Explicit package set owned by the framework distribution.
 */
function moveBundledWorkspaceDependencies(
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  frameworkOwnedPackages: ReadonlySet<string>,
): void {
  for (const packageName of new Set([...frameworkOwnedPackages, ...Object.keys(dependencies)])) {
    const version = dependencies[packageName];
    if (isBundledWorkspaceDependency(packageName, version, frameworkOwnedPackages)) {
      delete dependencies[packageName];
      devDependencies[packageName] = version;
    }
  }
}

/**
 * Build the portable export map from publish-time metadata.
 * @param packageJson - Source workspace package manifest.
 * @param rootEntrypoints - Resolved publishable root entrypoints.
 * @returns Export map suitable for the publishable manifest.
 */
function createPortableExports(packageJson: PackageJsonLike, rootEntrypoints: PublishRootEntrypoints): unknown {
  const publishExports = packageJson.publishConfig?.exports;
  const sourceExports =
    packageJson.exports && typeof packageJson.exports === 'object'
      ? (packageJson.exports as Record<string, string | { source?: string }>)
      : {};

  if (!publishExports || typeof publishExports !== 'object') {
    if (!packageJson.exports) return undefined;
    if (!hasRootExport(packageJson)) {
      return sourceExports['./package.json'] ? { './package.json': sourceExports['./package.json'] } : undefined;
    }
    return createRootPortableExports(sourceExports, rootEntrypoints);
  }

  const portableExports: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(publishExports)) {
    if (key === './package.json') {
      portableExports[key] = value;
      continue;
    }

    if (typeof value !== 'string') {
      portableExports[key] = value;
      continue;
    }

    portableExports[key] = {
      types: toTypesExportTarget(value),
      default: value,
    };
  }

  return portableExports;
}

/**
 * Transform a workspace `package.json` into a publishable portable manifest.
 *
 * Moves internal `@makaio/*` workspace dependencies from `dependencies` to
 * `devDependencies`, adds the `@makaio/framework` peer dependency, and marks
 * the package as non-private for publishing. Internal workspace packages are
 * bundled into adapter output at build time, so they must not remain runtime
 * dependencies in the published manifest.
 * @param packageJson - Source workspace `package.json`.
 * @param options - Portable package options.
 * @returns Transformed manifest suitable for npm publishing.
 */
export function createPortablePackageJson(
  packageJson: PackageJsonLike,
  options: PortablePackageOptions,
): PackageJsonLike {
  const frameworkOwnedPackages = new Set(options.frameworkOwnedPackages ?? FRAMEWORK_BUILD_PACKAGE_NAMES);
  const dependencies = { ...(packageJson.dependencies ?? {}) };
  const devDependencies = { ...(packageJson.devDependencies ?? {}) };
  const peerDependencies = { ...(packageJson.peerDependencies ?? {}) };
  const { main, types } = resolvePortableRootEntrypoints(packageJson);

  moveBundledWorkspaceDependencies(dependencies, devDependencies, frameworkOwnedPackages);
  peerDependencies['@makaio/framework'] = options.frameworkPeerRange ?? `^${options.frameworkVersion}`;

  return {
    ...packageJson,
    private: false,
    ...(main ? { main } : {}),
    ...(types ? { types } : {}),
    exports: createPortableExports(packageJson, { main, types }),
    dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
    devDependencies: Object.keys(devDependencies).length > 0 ? devDependencies : undefined,
    peerDependencies,
  };
}
