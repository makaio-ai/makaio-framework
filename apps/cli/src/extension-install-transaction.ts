/**
 * Shared extension install transaction logic.
 *
 * Extracts the install lifecycle — lazy package-manager import, npm resolution,
 * local symlink install, and snapshot rollback — into a reusable module consumed
 * by both the CLI's extension subcommand and any other command that needs to
 * install extensions (e.g. the top-level `makaio install` command).
 *
 * The key contract difference from the raw `DependencyResolver` result: the
 * {@link ExtensionInstallTransactionResult.directNpm} array contains only the
 * packages that were directly requested by the caller, not transitive deps.
 * Callers that need to write a manifest sync entry use `directNpm` so they do
 * not accidentally persist internal implementation details.
 * @packageDocumentation
 */

import * as path from 'node:path';
import { readFrameworkVersion, resolveMakaioHome } from '@makaio/runtime-node';
import type { InstallSource } from '@makaio/services-package-manager';
import {
  compareProjectManifestExtensions,
  extractNpmPackageName,
  formatExactExtensionSpec,
} from '@makaio/utils/project-manifest';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * A single directly-requested npm package that was resolved and installed (or
 * confirmed already present) by the transaction.
 */
export interface DirectNpmInstallResolution {
  /** npm package name without any version suffix. */
  readonly packageName: string;
  /** Resolved installed version string. */
  readonly version: string;
  /** The original specifier as passed by the caller (may include a version). */
  readonly spec: string;
}

/**
 * Aggregate result returned by {@link installExtensionSources} and
 * {@link installMissingManifestExtensions}.
 */
export interface ExtensionInstallTransactionResult {
  /**
   * Resolved records for every *directly requested* npm source.
   *
   * Transitive dependencies installed by the resolver are intentionally omitted.
   * Use this to write manifest sync entries without leaking internal dep graph.
   */
  readonly directNpm: readonly DirectNpmInstallResolution[];
  /** Package names of every local extension installed in this transaction. */
  readonly installedLocalPackageNames: readonly string[];
  /**
   * Whether this transaction produced any observable install change.
   *
   * `true` when at least one npm package was resolved or at least one local
   * package was installed. `false` when all sources were absent from the
   * results (e.g. empty source list or resolver returned nothing).
   */
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// Lazy import
// ---------------------------------------------------------------------------

type PackageManagerModule = typeof import('@makaio/services-package-manager');

/**
 * Lazily import the package-manager module.
 *
 * `@makaio/services-package-manager` transitively depends on `@yarnpkg/core`
 * and `@yarnpkg/fslib`, which use `eval('require')` internally — a CJS pattern
 * that fails under Bun's ESM bundler when included at module initialization
 * time. Deferring the import to the first action invocation keeps the module
 * out of the top-level initialization path, so `--version`, `--help`, and all
 * non-package-manager commands work without triggering the incompatible code.
 * @returns The `@makaio/services-package-manager` module exports.
 */
export async function importPackageManager(): Promise<PackageManagerModule> {
  return import('@makaio/services-package-manager');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Install one or more extensions from local paths or the npm registry as a
 * single atomic transaction.
 *
 * npm sources are batched through the {@link DependencyResolver} so that
 * transitive descriptor-declared dependencies are resolved in a single pass.
 * Local symlink installs run after npm succeeds; if any later step fails,
 * local symlinks installed in this batch are removed and the pre-install npm
 * manifest snapshot is restored before the error is re-thrown.
 *
 * Git URL sources are rejected synchronously before any install attempt.
 * @param sources - Raw source strings (local paths or npm package specs).
 * @param options - Install options.
 * @returns Aggregate transaction result describing what changed.
 */
export async function installExtensionSources(
  sources: readonly string[],
  options: { readonly force?: boolean } = {},
): Promise<ExtensionInstallTransactionResult> {
  const {
    parseInstallSource,
    YarnPackageManager,
    LocalPathInstaller,
    DependencyResolver,
    DescriptorNameResolver,
    RegistryService,
  } = await importPackageManager();

  const makaioHome = resolveMakaioHome();
  const parsedSources = sources.map((source) => parseInstallSource(source));

  const gitSource = parsedSources.find((source) => source.kind === 'git');
  if (gitSource) {
    throw new Error(`Git URL installs are not yet supported: ${gitSource.raw}`);
  }

  const localSources = parsedSources.filter((source) => source.kind === 'local');
  const npmSources = parsedSources.filter((source) => source.kind === 'npm');

  const yarn = new YarnPackageManager(makaioHome);
  await yarn.initialize();

  return performInstallTransaction(
    { LocalPathInstaller, DependencyResolver, DescriptorNameResolver, RegistryService },
    makaioHome,
    yarn,
    localSources,
    npmSources,
    options,
  );
}

/**
 * Reads installed packages and installs any manifest extensions that are
 * missing or version-mismatched using a single {@link YarnPackageManager}
 * instance for both the diff check and the install transaction.
 * @param manifestSpecs - Exact extension specs from the project manifest.
 * @param makaioHome - Path to the makaio home directory.
 * @returns Transaction result, or `null` if all specs are already satisfied.
 */
export async function installMissingManifestExtensions(
  manifestSpecs: readonly string[],
  makaioHome: string,
): Promise<ExtensionInstallTransactionResult | null> {
  const {
    parseInstallSource,
    YarnPackageManager,
    LocalPathInstaller,
    DependencyResolver,
    DescriptorNameResolver,
    RegistryService,
  } = await importPackageManager();

  const yarn = new YarnPackageManager(makaioHome);
  await yarn.initialize();

  const diff = compareProjectManifestExtensions(manifestSpecs, await yarn.listPackages());
  const missingSpecs = [
    ...diff.missing.map((entry) => entry.spec),
    ...diff.mismatched.map(({ manifest }) => manifest.spec),
  ];

  if (missingSpecs.length === 0) {
    return null;
  }

  for (const mismatch of diff.mismatched) {
    console.info(
      `Aligning ${mismatch.manifest.packageName}: installed ${mismatch.installedVersion}, project requires ${mismatch.manifest.version}.`,
    );
  }

  const parsedSources = missingSpecs.map((source) => parseInstallSource(source));
  const localSources = parsedSources.filter((source) => source.kind === 'local');
  const npmSources = parsedSources.filter((source) => source.kind === 'npm');

  return performInstallTransaction(
    { LocalPathInstaller, DependencyResolver, DescriptorNameResolver, RegistryService },
    makaioHome,
    yarn,
    localSources,
    npmSources,
    {},
  );
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Execute one install command as a transaction over npm roots and local symlinks.
 * @param packageManager - Package-manager constructors loaded lazily.
 * @param makaioHome - Resolved Makaio home directory.
 * @param yarn - Initialized Yarn package manager instance.
 * @param localSources - Local path sources to install after npm succeeds.
 * @param npmSources - npm package sources to resolve through the dependency resolver.
 * @param options - Install options.
 * @returns Aggregate transaction result.
 */
async function performInstallTransaction(
  packageManager: Pick<
    PackageManagerModule,
    'LocalPathInstaller' | 'DependencyResolver' | 'DescriptorNameResolver' | 'RegistryService'
  >,
  makaioHome: string,
  yarn: InstanceType<PackageManagerModule['YarnPackageManager']>,
  localSources: readonly InstallSource[],
  npmSources: readonly InstallSource[],
  options: { readonly force?: boolean },
): Promise<ExtensionInstallTransactionResult> {
  const npmSnapshot = npmSources.length > 0 ? await yarn.readManifestSnapshot() : null;

  try {
    const directNpm = await installNpmSources(packageManager, yarn, npmSources, options);
    const installedLocalPackageNames = await installLocalSources(
      new packageManager.LocalPathInstaller(path.join(makaioHome, 'extensions')),
      localSources,
    );

    const changed = directNpm.length > 0 || installedLocalPackageNames.length > 0;

    return { directNpm, installedLocalPackageNames, changed };
  } catch (error) {
    await restoreNpmSnapshot(yarn, npmSnapshot, error);
    throw error;
  }
}

/**
 * Install npm roots through the dependency resolver and print the result.
 *
 * Returns only the directly-requested root packages, not transitive deps, so
 * callers writing manifest entries do not inadvertently persist internal dep
 * graph detail.
 * @param packageManager - Package-manager constructors loaded lazily.
 * @param yarn - Initialized Yarn package manager.
 * @param npmSources - npm sources to resolve.
 * @param options - Install options.
 * @returns Resolved records for the directly-requested root packages only.
 */
async function installNpmSources(
  packageManager: Pick<PackageManagerModule, 'DependencyResolver' | 'DescriptorNameResolver' | 'RegistryService'>,
  yarn: InstanceType<PackageManagerModule['YarnPackageManager']>,
  npmSources: readonly InstallSource[],
  options: { readonly force?: boolean },
): Promise<readonly DirectNpmInstallResolution[]> {
  if (npmSources.length === 0) return [];

  const frameworkVersion = await readFrameworkVersion();
  await yarn.ensureFrameworkDependency({ versionRange: `^${frameworkVersion}` });
  const resolver = new packageManager.DependencyResolver(
    yarn,
    new packageManager.DescriptorNameResolver(new packageManager.RegistryService()),
  );
  const result = await resolver.resolve(
    npmSources.map((source) => source.resolved),
    { force: options.force, snapshot: null },
  );

  for (const pkg of result.installed) {
    console.info(
      `${pkg.source === 'already-present' ? 'Already installed' : 'Installed'} ${pkg.npmName}@${pkg.version}`,
    );
  }
  for (const skipped of result.skipped) {
    console.warn(`Skipped optional dependency ${skipped.npmName}: ${skipped.reason}`);
  }

  // Build a lookup by package name from all installed results (direct + transitive).
  const installedByName = new Map(result.installed.map((pkg) => [pkg.npmName, pkg]));

  // Return only the packages that correspond to the directly-requested root specs.
  return npmSources.flatMap((source) => {
    const rootName = extractNpmPackageName(source.resolved);
    const installed = installedByName.get(rootName);
    if (!installed) return [];
    return [
      {
        packageName: rootName,
        version: installed.version,
        spec: formatExactExtensionSpec(rootName, installed.version),
      },
    ];
  });
}

/**
 * Install local sources and roll back local symlinks if a later local install
 * fails.
 * @param localInstaller - Local path installer.
 * @param localSources - Local path sources to install.
 * @returns Package names of all successfully installed local extensions.
 */
async function installLocalSources(
  localInstaller: InstanceType<PackageManagerModule['LocalPathInstaller']>,
  localSources: readonly InstallSource[],
): Promise<readonly string[]> {
  const installedLocalNames: string[] = [];
  try {
    for (const source of localSources) {
      const result = await localInstaller.install(source.resolved);
      if (!result.success) {
        throw new Error(result.error ?? `Failed to install ${source.raw}`);
      }
      installedLocalNames.push(result.packageName);
      console.info(`Installed ${result.packageName}@${result.version} (local)`);
    }
  } catch (error) {
    const rollbackErrors: Error[] = [];
    for (const name of installedLocalNames.reverse()) {
      try {
        const rollbackResult = await localInstaller.uninstall(name);
        if (!rollbackResult.success) {
          rollbackErrors.push(new Error(rollbackResult.error ?? `Failed to uninstall local extension ${name}`));
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
      }
    }
    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackErrors.map((rollbackError) => rollbackError.message).join('; ');
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Install failed and local rollback failed: ${message}; rollback errors: ${rollbackMessage}`,
      );
    }
    throw error;
  }
  return installedLocalNames;
}

/**
 * Restore npm package state captured before an install transaction.
 * @param yarn - Yarn package manager.
 * @param snapshot - Manifest snapshot, or `null` when no npm sources were installed.
 * @param installError - Original install failure.
 */
async function restoreNpmSnapshot(
  yarn: InstanceType<PackageManagerModule['YarnPackageManager']>,
  snapshot: unknown,
  installError: unknown,
): Promise<void> {
  if (snapshot === null) return;

  try {
    await yarn.writeManifestAndReinstall(snapshot);
  } catch (rollbackError) {
    const message = installError instanceof Error ? installError.message : String(installError);
    throw new AggregateError([installError, rollbackError], `Install failed and npm rollback failed: ${message}`);
  }
}
