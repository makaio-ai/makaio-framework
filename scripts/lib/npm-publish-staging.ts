/**
 * npm publish staging helpers for public framework packages.
 *
 * The workspace manifests keep buildless `src/*.ts` exports for development.
 * Published artifacts are packed from a staged directory whose package metadata
 * points at built `dist/` files.
 * @packageDocumentation
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createPortablePackageJson, type PackageJsonLike } from '@makaio/build-tooling/portable-package';
import { isForbiddenPublishBuildArtifact } from './npm-packlist-policy.js';
import { copyRuntimeMigrationChain, isMigrationChainDirectory } from './runtime-migration-assets.js';

/** Directory, relative to each package root, used as the npm publish root. */
export const NPM_PUBLISH_DIRECTORY = 'node_modules/.makaio-publish';

/**
 * Derive the `@makaio/framework` peer dependency range from a publish version.
 *
 * Prerelease versions (those with a `-` component, e.g. `1.0.0-dev-123`) need
 * a range that explicitly includes prerelease identifiers because npm/pnpm
 * exclude them from `^X.Y.Z` by default. Stable versions keep the normal caret
 * form so consumers get compatible patch/minor updates.
 * @param version - The exact version string being published (e.g. `1.0.0` or
 *   `1.0.0-dev-1781260968078`).
 * @returns A semver range string suitable for `peerDependencies`.
 */
export function buildFrameworkPeerRange(version: string): string {
  const match = /^(\d+)\.(\d+\.\d+)(?:-([\s\S]+))?$/u.exec(version);
  if (!match) {
    throw new Error(`Cannot derive peer range from unsupported version format: "${version}"`);
  }
  const major = Number(match[1]);
  const isPrerelease = match[3] !== undefined;
  if (isPrerelease) {
    return `>=${major}.0.0-0 <${major + 1}.0.0`;
  }
  return `^${version}`;
}

/** Minimal manifest shape needed to resolve a publish staging directory. */
export interface PublishDirectoryPackageJson {
  readonly publishConfig?: {
    readonly directory?: string;
  };
}

/** Minimal package.json shape needed by publish staging. */
export interface PublishablePackageJson extends PackageJsonLike {
  readonly files?: readonly string[];
  readonly publishConfig?: PackageJsonLike['publishConfig'] & {
    readonly access?: string;
    readonly directory?: string;
  };
}

/**
 * Resolve the publish staging directory for a package.
 * @param packageDir - Absolute package root.
 * @param packageJson - Parsed package manifest.
 * @returns Absolute publish directory path.
 */
export function resolveNpmPublishDirectory(packageDir: string, packageJson: PublishDirectoryPackageJson): string {
  const packageRoot = resolve(packageDir);
  const directory = packageJson.publishConfig?.directory ?? NPM_PUBLISH_DIRECTORY;
  const publishDir = resolve(packageRoot, directory);
  const packageRootPrefix = `${packageRoot}${sep}`;
  if (publishDir === packageRoot || !publishDir.startsWith(packageRootPrefix)) {
    throw new Error(`npm publish directory escapes package root: ${directory}`);
  }
  return publishDir;
}

/**
 * Build the manifest written into the staged npm publish directory.
 *
 * `devDependencies` are always omitted from the staged manifest: published
 * packages have no use for them, and workspace-protocol entries in that field
 * would otherwise survive into the tarball.
 * @param packageJson - Source workspace package manifest.
 * @param frameworkVersion - Version of the public `@makaio/framework` package.
 * @param publishVersions - Exact versions for public workspace dependencies.
 * @returns Publish manifest with dist exports, devDependencies, and
 *   staging-only config removed.
 */
export function createStagedPackageJson(
  packageJson: PublishablePackageJson,
  frameworkVersion: string,
  publishVersions: Readonly<Record<string, string>> = {},
): PublishablePackageJson {
  if (packageJson.name === '@makaio/framework') {
    const {
      devDependencies: _devDependencies,
      publishWorkspaceDependencies: _publishWorkspaceDependencies,
      peerDependencies,
      ...manifest
    } = packageJson;
    const frameworkPeers = Object.fromEntries(
      Object.entries(peerDependencies ?? {}).filter(([name]) => name !== '@makaio/framework'),
    );
    return {
      ...manifest,
      version: frameworkVersion,
      private: false,
      ...(Object.keys(frameworkPeers).length > 0 ? { peerDependencies: frameworkPeers } : {}),
    };
  }

  const frameworkPeerRange = buildFrameworkPeerRange(frameworkVersion);
  const portablePackageJson = createPortablePackageJson(packageJson, {
    frameworkVersion,
    frameworkPeerRange,
    publishVersions,
  }) as PublishablePackageJson;
  // devDependencies have no meaning in a published package and may contain
  // raw workspace: specifiers that cannot resolve outside this repository.
  const { publishConfig, devDependencies: _devDependencies, ...manifest } = portablePackageJson;
  const publishSettings = Object.fromEntries(
    Object.entries(publishConfig ?? {}).filter(([key]) => !['directory', 'exports', 'main', 'types'].includes(key)),
  );

  return {
    ...manifest,
    ...(Object.keys(publishSettings).length > 0 ? { publishConfig: publishSettings } : {}),
  };
}

/**
 * Return a package path without its optional leading `./`.
 * @param target - Package-relative manifest target.
 * @returns Target without a leading `./`.
 */
function stripPackageRelativePrefix(target: string): string {
  return target.startsWith('./') ? target.slice(2) : target;
}

/**
 * Return whether a copied source should be staged into the publish directory.
 * @param packageRoot - Absolute package root used to derive a policy path.
 * @param source - Absolute source path currently being copied.
 * @returns Whether the file should be included in the staged package.
 */
function shouldStagePublishFile(packageRoot: string, source: string): boolean {
  const packageRelativePath = relative(packageRoot, source).split(sep).join('/');
  return !isForbiddenPublishBuildArtifact(packageRelativePath);
}

/**
 * Resolve a declaration target to the emitted file extension in the staged package.
 * @param publishDir - Absolute publish staging directory.
 * @param target - Package-relative declaration target from the manifest.
 * @returns The original target, or the matching emitted `.d.ts` target.
 */
function resolveStagedDeclarationTarget(publishDir: string, target: string): string {
  if (existsSync(join(publishDir, stripPackageRelativePrefix(target)))) {
    return target;
  }

  const candidates = target.endsWith('.d.mts')
    ? [target.replace(/\.d\.mts$/u, '.d.ts')]
    : target.endsWith('.d.cts')
      ? [target.replace(/\.d\.cts$/u, '.d.ts')]
      : [];

  return candidates.find((candidate) => existsSync(join(publishDir, stripPackageRelativePrefix(candidate)))) ?? target;
}

/**
 * Rewrite manifest declaration targets so they match staged declaration files.
 * @param publishDir - Absolute publish staging directory.
 * @param value - Manifest object or nested export value.
 * @returns Manifest value with `types` paths reconciled.
 */
function normalizeStagedDeclarationTargets(publishDir: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStagedDeclarationTargets(publishDir, entry));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      key === 'types' && typeof nestedValue === 'string'
        ? resolveStagedDeclarationTarget(publishDir, nestedValue)
        : normalizeStagedDeclarationTargets(publishDir, nestedValue),
    ]),
  );
}

/**
 * Stage one package for npm publishing.
 * @param packageDir - Absolute package root.
 * @param frameworkVersion - Version of the public `@makaio/framework` package.
 * @param publishVersions - Exact versions for public workspace dependencies.
 * @returns Absolute path to the staged publish directory.
 */
export function stagePackageForNpmPublish(
  packageDir: string,
  frameworkVersion: string,
  publishVersions: Readonly<Record<string, string>> = {},
): string {
  const packageRoot = resolve(packageDir);
  const packageRootPrefix = `${packageRoot}${sep}`;
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PublishablePackageJson;
  const publishDir = resolveNpmPublishDirectory(packageRoot, packageJson);
  const files = packageJson.files;

  if (!files || files.length === 0) {
    throw new Error(`Publishable package is missing files list: ${packageJson.name}`);
  }

  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });

  for (const file of files) {
    if (file === 'package.json') continue;

    const source = resolve(packageRoot, file);
    if (source === packageRoot || !source.startsWith(packageRootPrefix)) {
      throw new Error(`${packageJson.name}: publish file escapes package root: ${file}`);
    }
    if (!existsSync(source)) {
      throw new Error(`${packageJson.name}: publish file is missing before staging: ${file}`);
    }
    if (isMigrationChainDirectory(source)) {
      copyRuntimeMigrationChain(source, join(publishDir, file));
    } else {
      cpSync(source, join(publishDir, file), {
        recursive: true,
        filter: (copiedSource) => shouldStagePublishFile(packageRoot, copiedSource),
      });
    }
  }

  const stagedPackageJson = normalizeStagedDeclarationTargets(
    publishDir,
    createStagedPackageJson(packageJson, frameworkVersion, publishVersions),
  );

  writeFileSync(join(publishDir, 'package.json'), `${JSON.stringify(stagedPackageJson, null, 2)}\n`, 'utf8');

  return publishDir;
}
