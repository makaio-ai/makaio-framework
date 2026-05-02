import * as path from 'node:path';
import { Command, InvalidOptionArgumentError } from 'commander';
import { createExtensionScaffold, type ExtensionSurface } from './extension-init.js';
import { verifyExtensionWorkspace } from './extension-verify.js';
import { resolveMakaioHome } from '@makaio/runtime-node';

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
    .command('install <source>')
    .description('Install an extension from npm or a local path')
    .action(async (source: string) => runInstall(source));

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
 * Install an extension from a local path or npm registry.
 * @param source - Raw CLI source string (local path or npm package name).
 */
async function runInstall(source: string): Promise<void> {
  try {
    const { parseInstallSource, YarnPackageManager, LocalPathInstaller } = await importPackageManager();
    const makaioHome = resolveMakaioHome();
    const parsed = parseInstallSource(source);

    if (parsed.kind === 'git') {
      console.error('Git URL installs are not yet supported.');
      process.exitCode = 1;
      return;
    }

    if (parsed.kind === 'local') {
      const installer = new LocalPathInstaller(path.join(makaioHome, 'extensions'));
      const result = await installer.install(parsed.resolved);
      if (!result.success) {
        console.error(`Install failed: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.info(`Installed ${result.packageName}@${result.version} (local)`);
      if (result.restartRequired) {
        console.info('Restart makaio to activate.');
      }
      return;
    }

    // npm install
    const yarn = new YarnPackageManager(makaioHome);
    await yarn.initialize();
    const version = await yarn.installPackage(parsed.resolved);
    console.info(`Installed ${source}@${version}`);
    console.info('Restart makaio to activate.');
  } catch (error) {
    console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
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
