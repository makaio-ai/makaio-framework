import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Explicit local contributor mode for the in-repo extension source tree.
 */
export const REPO_DEV_MODE = 'repo-dev';

/**
 * Portable source-package output directory beneath the extension root.
 */
export const PORTABLE_SOURCE_DIRECTORY = 'build/portable-source';

const FRAMEWORK_PACKAGE_PATHS = {
  '@makaio/build-tooling': 'build-tooling',
  '@makaio/bus-core': 'packages/bus-core',
  '@makaio/contracts': 'packages/contracts',
  '@makaio/core': 'packages/makaio-core',
  '@makaio/runtime-node': 'runtimes/node',
  '@makaio/service-base': 'packages/services/base',
  '@makaio/test-utils': 'packages/test-utils',
  '@makaio/ui-hooks': 'ui/hooks',
  '@makaio/ui-kernel': 'ui/kernel',
  '@makaio/ui-theme': 'ui/theme',
  '@makaio/ui-views': 'ui/views',
} as const;

const REPO_DEV_ALIAS_PATHS = {
  '@makaio/bus-core': 'packages/bus-core/src',
  '@makaio/contracts': 'packages/contracts/src',
  '@makaio/runtime-node': 'runtimes/node/src',
  '@makaio/service-base': 'packages/services/base/src',
} as const;

type FrameworkPackageName = keyof typeof FRAMEWORK_PACKAGE_PATHS;

/**
 * Minimal package.json shape used by the portable-package staging helpers.
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
 * Build the explicit repo-dev alias map for `account-manager`.
 * @param extensionRoot - Absolute account-manager root directory.
 * @returns Absolute alias targets keyed by package specifier.
 */
export function createRepoDevAliases(extensionRoot: string): Record<string, string> {
  const repoRoot = resolveRepoRoot(extensionRoot);

  return Object.fromEntries(
    Object.entries(REPO_DEV_ALIAS_PATHS).map(([specifier, repoRelativePath]) => [
      specifier,
      path.join(repoRoot, repoRelativePath),
    ]),
  );
}

/**
 * Read version numbers for the internal framework packages used by the staged
 * portable source package.
 * @param repoRoot - Absolute framework workspace root.
 * @returns Published-version map keyed by package name.
 */
export async function readFrameworkPackageVersions(repoRoot: string): Promise<Record<FrameworkPackageName, string>> {
  const entries = await Promise.all(
    Object.entries(FRAMEWORK_PACKAGE_PATHS).map(async ([packageName, repoRelativePath]) => {
      const packageJsonPath = path.join(repoRoot, repoRelativePath, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { readonly version?: unknown };
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
 * Rewrite the repo-dev manifest into a portable source-package manifest.
 *
 * The staged package keeps the same runtime contract, but swaps local `link:`
 * framework development dependencies for semver dependencies and removes the
 * repo-dev helper scripts that only make sense against local framework sources.
 * @param packageJson - Current repo-dev package.json contents.
 * @param versions - Version map for internal framework packages.
 * @returns Portable source-package manifest.
 */
export function createPortablePackageJson(
  packageJson: ExtensionPackageJson,
  versions: Record<FrameworkPackageName, string>,
): ExtensionPackageJson {
  const devDependencies = { ...(packageJson.devDependencies ?? {}) };
  for (const packageName of Object.keys(FRAMEWORK_PACKAGE_PATHS) as FrameworkPackageName[]) {
    const currentVersion = devDependencies[packageName];
    if (isLocalPackageReference(currentVersion)) {
      devDependencies[packageName] = `^${versions[packageName]}`;
    }
  }

  const peerDependencies = { ...(packageJson.peerDependencies ?? {}) };
  if (!peerDependencies['@makaio/bus-core']) {
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
