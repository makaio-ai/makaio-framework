import {
  PORTABLE_SOURCE_DIRECTORY,
  REPO_DEV_MODE,
  createPortablePackageJson as createPortablePackageJsonForConfig,
  createRepoDevAliases as createRepoDevAliasesForConfig,
  isRepoDevMode,
  readFrameworkPackageVersions as readFrameworkPackageVersionsForConfig,
  resolveRepoRoot,
  type ExtensionPackageJson,
} from '../../shared/package-mode.js';

export { PORTABLE_SOURCE_DIRECTORY, REPO_DEV_MODE, isRepoDevMode, resolveRepoRoot };
export type { ExtensionPackageJson };

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
 * Build the explicit repo-dev alias map for `account-manager`.
 * @param extensionRoot - Absolute account-manager root directory.
 * @returns Absolute alias targets keyed by package specifier.
 */
export function createRepoDevAliases(extensionRoot: string): Record<string, string> {
  return createRepoDevAliasesForConfig(extensionRoot, REPO_DEV_ALIAS_PATHS);
}

/**
 * Read version numbers for the internal framework packages used by the staged
 * portable source package.
 * @param repoRoot - Absolute framework workspace root.
 * @returns Published-version map keyed by package name.
 */
export function readFrameworkPackageVersions(repoRoot: string): Promise<Record<FrameworkPackageName, string>> {
  return readFrameworkPackageVersionsForConfig(repoRoot, FRAMEWORK_PACKAGE_PATHS);
}

/**
 * Rewrite the repo-dev manifest into a portable source-package manifest.
 * @param packageJson - Current repo-dev package.json contents.
 * @param versions - Version map for internal framework packages.
 * @returns Portable source-package manifest.
 */
export function createPortablePackageJson(
  packageJson: ExtensionPackageJson,
  versions: Record<FrameworkPackageName, string>,
): ExtensionPackageJson {
  return createPortablePackageJsonForConfig(packageJson, versions, FRAMEWORK_PACKAGE_PATHS);
}
