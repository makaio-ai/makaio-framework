import * as path from 'node:path';
import { Command, InvalidOptionArgumentError } from 'commander';
import { createExtensionScaffold, type ExtensionSurface } from './extension-init.js';
import { verifyExtensionWorkspace } from './extension-verify.js';
import { resolveMakaioHome } from '@makaio/runtime-node';
import { importPackageManager, installExtensionSources } from './extension-install-transaction.js';
import {
  syncExistingProjectManifestPinsAfterUpdate,
  syncProjectManifestAfterInstall,
  syncProjectManifestAfterUninstall,
} from './project-manifest-sync.js';

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
 * Run a manifest sync operation, printing a warning instead of throwing on
 * failure. Manifest sync is best-effort: a stale or missing manifest must
 * never block the install or uninstall command itself.
 * @param operation - Async manifest sync callback to execute.
 */
async function warnOnManifestSyncFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(`Project manifest sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Install one or more extensions from local paths or the npm registry.
 *
 * Delegates the transaction to {@link installExtensionSources} and prints a
 * restart reminder when any install modified state.
 * @param sources - Raw CLI source strings (local paths or npm package names).
 * @param options - Install options.
 */
async function runInstall(sources: readonly string[], options: { readonly force?: boolean } = {}): Promise<void> {
  try {
    const result = await installExtensionSources(sources, options);
    await warnOnManifestSyncFailure(() => syncProjectManifestAfterInstall(process.cwd(), result.directNpm));
    if (result.changed) {
      console.info('Restart makaio to activate.');
    }
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
    await warnOnManifestSyncFailure(() => syncProjectManifestAfterUninstall(process.cwd(), name));
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

    const updatedPins: Array<{ packageName: string; version: string; spec: string }> = [];
    for (const pkg of targets) {
      const latest = await yarn.getLatestVersion(pkg.name);
      if (latest === 'unknown') {
        console.warn(`Could not determine latest version for ${pkg.name}; skipping.`);
        continue;
      }
      if (latest !== pkg.version) {
        const version = await yarn.installPackage(pkg.name);
        updatedPins.push({ packageName: pkg.name, version, spec: `${pkg.name}@${version}` });
        console.info(`Updated ${pkg.name}: ${pkg.version} → ${latest}`);
      } else {
        console.info(`${pkg.name}@${pkg.version} is up to date.`);
      }
    }
    await warnOnManifestSyncFailure(() => syncExistingProjectManifestPinsAfterUpdate(process.cwd(), updatedPins));
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
