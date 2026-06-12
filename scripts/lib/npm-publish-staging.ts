/**
 * npm publish staging helpers for public framework packages.
 *
 * The workspace manifests keep buildless `src/*.ts` exports for development.
 * Published artifacts are packed from a staged directory whose package metadata
 * points at built `dist/` files.
 * @packageDocumentation
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPortablePackageJson, type PackageJsonLike } from '@makaio/build-tooling/portable-package';

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
  const directory = packageJson.publishConfig?.directory ?? NPM_PUBLISH_DIRECTORY;
  return resolve(packageDir, directory);
}

/**
 * Build the manifest written into the staged npm publish directory.
 *
 * `devDependencies` are always omitted from the staged manifest: published
 * packages have no use for them, and workspace-protocol entries in that field
 * would otherwise survive into the tarball.
 * @param packageJson - Source workspace package manifest.
 * @param frameworkVersion - Version of the public `@makaio/framework` package.
 * @returns Publish manifest with dist exports, devDependencies, and
 *   staging-only config removed.
 */
export function createStagedPackageJson(
  packageJson: PublishablePackageJson,
  frameworkVersion: string,
): PublishablePackageJson {
  const frameworkPeerRange = buildFrameworkPeerRange(frameworkVersion);
  const portablePackageJson = createPortablePackageJson(packageJson, {
    frameworkVersion,
    frameworkPeerRange,
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
 * Stage one package for npm publishing.
 * @param packageDir - Absolute package root.
 * @param frameworkVersion - Version of the public `@makaio/framework` package.
 * @returns Absolute path to the staged publish directory.
 */
export function stagePackageForNpmPublish(packageDir: string, frameworkVersion: string): string {
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PublishablePackageJson;
  const publishDir = resolveNpmPublishDirectory(packageDir, packageJson);
  const files = packageJson.files;

  if (!files || files.length === 0) {
    throw new Error(`Publishable package is missing files list: ${packageJson.name}`);
  }

  rmSync(publishDir, { recursive: true, force: true });
  mkdirSync(publishDir, { recursive: true });

  for (const file of files) {
    if (file === 'package.json') continue;

    const source = join(packageDir, file);
    if (!existsSync(source)) {
      throw new Error(`${packageJson.name}: publish file is missing before staging: ${file}`);
    }
    cpSync(source, join(publishDir, file), { recursive: true });
  }

  writeFileSync(
    join(publishDir, 'package.json'),
    `${JSON.stringify(createStagedPackageJson(packageJson, frameworkVersion), null, 2)}\n`,
    'utf8',
  );

  return publishDir;
}
