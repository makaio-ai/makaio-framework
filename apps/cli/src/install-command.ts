import { Command } from 'commander';
import { findProjectManifestPath, readProjectManifest } from '@makaio/utils/project-manifest';
import { installMissingManifestExtensions } from './extension-install-transaction.js';

type CommandInstance = InstanceType<typeof Command>;

/** Context required by the install command. */
export interface InstallCommandContext {
  readonly makaioHome: string;
}

/**
 * Registers the top-level `makaio install` command.
 * Reads the project manifest and installs missing or version-mismatched extensions.
 * @param program - Commander program instance
 * @param ctx - Command context with makaioHome path
 */
export function registerInstallCommand(program: CommandInstance, ctx: InstallCommandContext): void {
  program
    .command('install [manifestPath]')
    .description('Install project extension requirements from .makaio/manifest.json')
    .action(async (manifestPath?: string) => {
      try {
        const resolvedManifestPath = manifestPath ?? (await findProjectManifestPath(process.cwd()));
        if (resolvedManifestPath === null) {
          throw new Error('No .makaio/manifest.json found from the current directory.');
        }
        const manifest = await readProjectManifest(resolvedManifestPath);
        const result = await installMissingManifestExtensions(manifest.extensions, ctx.makaioHome);
        if (result === null || !result.changed) {
          console.info('All project extensions are installed.');
        } else {
          console.info('Restart makaio to activate.');
        }
      } catch (error) {
        console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
