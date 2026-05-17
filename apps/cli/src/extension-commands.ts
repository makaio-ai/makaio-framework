import * as path from 'node:path';
import { Command, InvalidOptionArgumentError } from 'commander';
import type { InstallSource } from '@makaio/services-package-manager';
import { createExtensionScaffold, type ExtensionSurface } from './extension-init.js';
import { verifyExtensionWorkspace } from './extension-verify.js';
import { readFrameworkVersion, resolveMakaioHome } from '@makaio/runtime-node';

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
async function importPackageManager(): Promise<typeof import('@makaio/services-package-manager')> {
  return import('@makaio/services-package-manager');
}

type CommandInstance = InstanceType<typeof Command>;
type PackageManagerModule = typeof import('@makaio/services-package-manager');

const SUPPORTED_SURFACES = ['server', 'browser', 'cli'] as const satisfies readonly ExtensionSurface[];

/**
 * Register local extension authoring commands.
 * @param program - Root Commander program.
 */
export function registerExtensionCommands(program: CommandInstance): void {
  const extension = program.command('extension').description('Local extension authoring commands');

  extension
    .command('init <name>')
    .description('Create a local extension scaffold')
    .option('--display-name <displayName>', 'Display name shown in Makaio surfaces')
    .option('--surface <surfaceList>', 'Comma-separated surfaces: server,browser,cli', parseSurfaceOption, ['server'])
    .option('--scope <scope>', 'Optional npm scope for package.json (for example @acme)')
    .option('--out-dir <outDir>', 'Target directory for the new extension workspace')
    .action(
      async (
        name: string,
        options: {
          readonly displayName?: string;
          readonly surface: readonly ExtensionSurface[];
          readonly scope?: string;
          readonly outDir?: string;
        },
      ) => {
        try {
          const result = await createExtensionScaffold({
            name,
            displayName: options.displayName,
            surfaces: options.surface,
            scope: options.scope,
            outDir: options.outDir,
          });
          console.info(`Created extension scaffold at ${result.rootDir}`);
        } catch (error) {
          console.error(`Extension init failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      },
    );

  extension
    .command('verify')
    .description('Verify the local extension workspace against the built entrypoint contract')
    .option('--cwd <cwd>', 'Extension root to verify')
    .action(async (options: { readonly cwd?: string }) => {
      try {
        const result = await verifyExtensionWorkspace({ cwd: options.cwd });
        console.info(`Extension verified at ${result.rootDir}`);
      } catch (error) {
        console.error(`Extension verify failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  extension
    .command('install <sources...>')
    .description('Install extensions from npm or local paths')
    .option('--force', 'Skip compatibility checks for dependency upgrades')
    .action(async (sources: string[], options: { readonly force?: boolean }) => runInstall(sources, options));

  extension
    .command('uninstall <name>')
    .description('Uninstall an extension')
    .action(async (name: string) => runUninstall(name));

  extension
    .command('list')
    .description('List installed extensions')
    .action(async () => runList());

  extension
    .command('update [name]')
    .description('Update one or all installed extensions')
    .action(async (name?: string) => runUpdate(name));
}

// ---------------------------------------------------------------------------
// Action handlers — extracted to keep registerExtensionCommands within the
// max-lines-per-function budget while preserving readable action bodies.
// ---------------------------------------------------------------------------

/**
 * Install one or more extensions from local paths or the npm registry.
 *
 * npm sources are batched through the {@link DependencyResolver} so that
 * transitive descriptor-declared dependencies are resolved in a single pass.
 * Local symlink installs run after npm succeeds; if any later step fails, local
 * symlinks installed in this batch are removed and the pre-install npm manifest
 * snapshot is restored before the error is re-thrown.
 * @param sources - Raw CLI source strings (local paths or npm package names).
 * @param options - Install options.
 */
async function runInstall(sources: readonly string[], options: { readonly force?: boolean } = {}): Promise<void> {
  try {
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
      console.error(`Git URL installs are not yet supported: ${gitSource.raw}`);
      process.exitCode = 1;
      return;
    }

    const localSources = parsedSources.filter((source) => source.kind === 'local');
    const npmSources = parsedSources.filter((source) => source.kind === 'npm');

    await performInstallTransaction(
      { YarnPackageManager, LocalPathInstaller, DependencyResolver, DescriptorNameResolver, RegistryService },
      makaioHome,
      localSources,
      npmSources,
      options,
    );

    if (npmSources.length > 0 || localSources.length > 0) {
      console.info('Restart makaio to activate.');
    }
  } catch (error) {
    console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Execute one install command as a transaction over npm roots and local symlinks.
 * @param packageManager - Package-manager constructors loaded lazily.
 * @param makaioHome - Resolved Makaio home directory.
 * @param localSources - Local path sources to install after npm succeeds.
 * @param npmSources - npm package sources to resolve through the dependency resolver.
 * @param options - Install options.
 */
async function performInstallTransaction(
  packageManager: Pick<
    PackageManagerModule,
    'YarnPackageManager' | 'LocalPathInstaller' | 'DependencyResolver' | 'DescriptorNameResolver' | 'RegistryService'
  >,
  makaioHome: string,
  localSources: readonly InstallSource[],
  npmSources: readonly InstallSource[],
  options: { readonly force?: boolean },
): Promise<void> {
  const yarn = new packageManager.YarnPackageManager(makaioHome);
  await yarn.initialize();
  const npmSnapshot = npmSources.length > 0 ? await yarn.readManifestSnapshot() : null;

  try {
    await installNpmSources(packageManager, yarn, npmSources, options);
    await installLocalSources(new packageManager.LocalPathInstaller(path.join(makaioHome, 'extensions')), localSources);
  } catch (error) {
    await restoreNpmSnapshot(yarn, npmSnapshot, error);
    throw error;
  }
}

/**
 * Install npm roots through the dependency resolver and print the result.
 * @param packageManager - Package-manager constructors loaded lazily.
 * @param yarn - Initialized Yarn package manager.
 * @param npmSources - npm sources to resolve.
 * @param options - Install options.
 */
async function installNpmSources(
  packageManager: Pick<PackageManagerModule, 'DependencyResolver' | 'DescriptorNameResolver' | 'RegistryService'>,
  yarn: InstanceType<PackageManagerModule['YarnPackageManager']>,
  npmSources: readonly InstallSource[],
  options: { readonly force?: boolean },
): Promise<void> {
  if (npmSources.length === 0) return;

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
}

/**
 * Install local sources and roll back local symlinks if a later local install fails.
 * @param localInstaller - Local path installer.
 * @param localSources - Local path sources to install.
 */
async function installLocalSources(
  localInstaller: InstanceType<PackageManagerModule['LocalPathInstaller']>,
  localSources: readonly InstallSource[],
): Promise<void> {
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
        const result = await localInstaller.uninstall(name);
        if (!result.success) {
          rollbackErrors.push(new Error(result.error ?? `Failed to uninstall local extension ${name}`));
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
}

/**
 * Restore npm package state captured before an install transaction.
 * @param yarn - Yarn package manager.
 * @param snapshot - Manifest snapshot, or `null` when no npm sources were installed.
 * @param installError - Original install failure.
 */
async function restoreNpmSnapshot(
  yarn: InstanceType<PackageManagerModule['YarnPackageManager']>,
  snapshot: unknown | null,
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

/**
 * Uninstall an extension by name, checking local symlinks before npm.
 * @param name - Extension name as declared in its descriptor.
 */
async function runUninstall(name: string): Promise<void> {
  try {
    const { YarnPackageManager, LocalPathInstaller } = await importPackageManager();
    const makaioHome = resolveMakaioHome();
    const localInstaller = new LocalPathInstaller(path.join(makaioHome, 'extensions'));
    const localExts = await localInstaller.list();

    if (localExts.some((e) => e.name === name)) {
      await localInstaller.uninstall(name);
      console.info(`Uninstalled ${name} (local)`);
      return;
    }

    const yarn = new YarnPackageManager(makaioHome);
    await yarn.initialize();
    await yarn.uninstallPackage(name);
    console.info(`Uninstalled ${name}`);
  } catch (error) {
    console.error(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * List all installed extensions (local symlinks and npm packages).
 */
async function runList(): Promise<void> {
  try {
    const { YarnPackageManager, LocalPathInstaller } = await importPackageManager();
    const makaioHome = resolveMakaioHome();

    const localInstaller = new LocalPathInstaller(path.join(makaioHome, 'extensions'));
    const yarn = new YarnPackageManager(makaioHome);

    const [localExts, npmExts] = await Promise.all([
      localInstaller.list(),
      yarn.initialize().then(() => yarn.listPackages()),
    ]);

    if (localExts.length === 0 && npmExts.length === 0) {
      console.info('No extensions installed.');
      return;
    }

    for (const ext of localExts) {
      console.info(`${ext.name}@${ext.version} (local)`);
    }
    for (const ext of npmExts) {
      console.info(`${ext.name}@${ext.version} (npm)`);
    }
  } catch (error) {
    console.error(`List failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Update one or all npm-installed extensions to their latest published version.
 * @param name - Optional extension name. When omitted, all npm extensions are updated.
 */
async function runUpdate(name?: string): Promise<void> {
  try {
    const { YarnPackageManager } = await importPackageManager();
    const makaioHome = resolveMakaioHome();
    const yarn = new YarnPackageManager(makaioHome);
    await yarn.initialize();

    const packages = await yarn.listPackages();
    const targets = name ? packages.filter((p) => p.name === name) : packages;

    if (targets.length === 0) {
      console.info(name ? `Extension ${name} not found.` : 'No npm extensions installed.');
      return;
    }

    for (const pkg of targets) {
      const latest = await yarn.getLatestVersion(pkg.name);
      if (latest === 'unknown') {
        console.warn(`Could not determine latest version for ${pkg.name}; skipping.`);
        continue;
      }
      if (latest !== pkg.version) {
        await yarn.installPackage(pkg.name);
        console.info(`Updated ${pkg.name}: ${pkg.version} → ${latest}`);
      } else {
        console.info(`${pkg.name}@${pkg.version} is up to date.`);
      }
    }
  } catch (error) {
    console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Parse the `--surface` option into a canonical surface list.
 * @param value - Raw comma-separated surface list.
 * @returns Canonically ordered, deduplicated surface list.
 */
function parseSurfaceOption(value: string): readonly ExtensionSurface[] {
  const requested = value
    .split(',')
    .map((surface) => surface.trim())
    .filter((surface) => surface.length > 0);

  if (requested.length === 0) {
    throw new InvalidOptionArgumentError('Surface list must not be empty.');
  }

  const requestedSet = new Set<ExtensionSurface>();
  for (const surface of requested) {
    if (!SUPPORTED_SURFACES.includes(surface as ExtensionSurface)) {
      throw new InvalidOptionArgumentError(
        `Unsupported surface "${surface}". Expected one of: ${SUPPORTED_SURFACES.join(', ')}.`,
      );
    }
    requestedSet.add(surface as ExtensionSurface);
  }

  return SUPPORTED_SURFACES.filter((surface) => requestedSet.has(surface));
}
