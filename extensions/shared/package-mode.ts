import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Explicit local contributor mode for in-repo extension source trees.
 */
export const REPO_DEV_MODE = 'repo-dev';

/**
 * Portable source-package output directory beneath an extension root.
 */
export const PORTABLE_SOURCE_DIRECTORY = 'build/portable-source';

/**
 * Minimal package.json shape used by portable-package staging helpers.
 */
export interface ExtensionPackageJson {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly type: 'module';
  readonly exports?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly publishConfig?: {
    readonly exports?: Record<string, string>;
  };
}

type PackagePathsWithBusCore<FrameworkPackageName extends string> = Record<FrameworkPackageName, string> &
  Record<'@makaio/bus-core', string>;

type PackageVersionsWithBusCore<FrameworkPackageName extends string> = Record<FrameworkPackageName, string> &
  Record<'@makaio/bus-core', string>;

/**
 * Determine whether the current command runs in explicit repo-dev mode.
 * @param env - Environment map to inspect.
 * @returns `true` when local source aliases should be enabled.
 */
export function isRepoDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MAKAIO_EXTENSION_MODE'] === REPO_DEV_MODE;
}

/**
 * Resolve the framework root from an extension root inside `extensions/`.
 * @param extensionRoot - Absolute extension root directory.
 * @returns Absolute framework root directory.
 */
export function resolveRepoRoot(extensionRoot: string): string {
  return path.resolve(extensionRoot, '../..');
}

/**
 * Build an explicit repo-dev alias map for an extension.
 * @param extensionRoot - Absolute extension root directory.
 * @param aliasPaths - Repo-root-relative alias targets keyed by package specifier.
 * @returns Absolute alias targets keyed by package specifier.
 */
export function createRepoDevAliases(
  extensionRoot: string,
  aliasPaths: Record<string, string>,
): Record<string, string> {
  const repoRoot = resolveRepoRoot(extensionRoot);

  return Object.fromEntries(
    Object.entries(aliasPaths).map(([specifier, repoRelativePath]) => [
      specifier,
      path.join(repoRoot, repoRelativePath),
    ]),
  );
}

/**
 * Read version numbers for configured internal framework packages.
 * @param repoRoot - Absolute framework workspace root.
 * @param packagePaths - Repo-root-relative package roots keyed by package name.
 * @returns Published-version map keyed by package name.
 */
export async function readFrameworkPackageVersions<FrameworkPackageName extends string>(
  repoRoot: string,
  packagePaths: Record<FrameworkPackageName, string>,
): Promise<Record<FrameworkPackageName, string>> {
  const entries = await Promise.all(
    Object.entries(packagePaths).map(async ([packageName, repoRelativePath]) => {
      const packageJsonPath = path.join(repoRoot, repoRelativePath as string, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };

      if (packageJson.name !== packageName) {
        throw new Error(`Expected package ${packageName} in ${packageJsonPath}`);
      }

      const version = packageJson.version;

      if (typeof version !== 'string' || version.length === 0) {
        throw new Error(`Missing package version in ${packageJsonPath}`);
      }

      return [packageName as FrameworkPackageName, version] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<FrameworkPackageName, string>;
}

/**
 * Rewrite a repo-dev manifest into a portable source-package manifest.
 *
 * The staged package keeps the same runtime contract, but swaps local `link:`
 * framework development dependencies for semver dependencies and removes the
 * repo-dev helper scripts that only make sense against local framework sources.
 * @param packageJson - Current repo-dev package.json contents.
 * @param versions - Version map for internal framework packages.
 * @param packagePaths - Configured framework packages for this extension.
 * @returns Portable source-package manifest.
 */
export function createPortablePackageJson<FrameworkPackageName extends string>(
  packageJson: ExtensionPackageJson,
  versions: PackageVersionsWithBusCore<FrameworkPackageName>,
  packagePaths: PackagePathsWithBusCore<FrameworkPackageName>,
): ExtensionPackageJson {
  const devDependencies = { ...(packageJson.devDependencies ?? {}) };
  for (const packageName of Object.keys(packagePaths) as FrameworkPackageName[]) {
    const currentVersion = devDependencies[packageName];
    if (isLocalPackageReference(currentVersion)) {
      devDependencies[packageName] = `^${versions[packageName]}`;
    }
  }

  const peerDependencies = { ...(packageJson.peerDependencies ?? {}) };
  // Portable extensions share the host process bus, so bus-core must remain a
  // peer even when a repo-dev manifest omitted the local workspace reference.
  if (isLocalPackageReference(peerDependencies['@makaio/bus-core'])) {
    peerDependencies['@makaio/bus-core'] = `^${versions['@makaio/bus-core']}`;
  } else if (!peerDependencies['@makaio/bus-core']) {
    peerDependencies['@makaio/bus-core'] = `^${versions['@makaio/bus-core']}`;
  }

  return {
    ...packageJson,
    scripts: {
      build: 'tsdown',
      test: 'vitest run --config vitest.config.ts',
      verify: 'vitest run test/verify.test.ts --config vitest.config.ts',
    },
    peerDependencies,
    devDependencies,
  };
}

/**
 * Detect whether a dependency spec points at a local package path.
 * @param versionSpecifier - Dependency version string to inspect.
 * @returns `true` when the specifier uses a local file/link reference.
 */
function isLocalPackageReference(versionSpecifier: string | undefined): boolean {
  if (!versionSpecifier) {
    return false;
  }

  return (
    versionSpecifier.startsWith('link:') ||
    versionSpecifier.startsWith('file:') ||
    versionSpecifier.startsWith('workspace:')
  );
}
