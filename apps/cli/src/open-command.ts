import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Command } from 'commander';
import { probeHealth, connectBusClient, resolveClientAuth } from './bus-client.js';
import { HostSubjects } from '@makaio/contracts';

const MAKAIO_APP_ENV = 'MAKAIO_APP';

/**
 * Register the `open` subcommand.
 * @param program - The root Commander program.
 */
export function registerOpenCommand(program: Command): void {
  program
    .command('open')
    .description('Open the Makaio desktop app, or focus it if already running')
    .action(async () => {
      const health = await probeHealth();

      if (health) {
        let bus: Awaited<ReturnType<typeof connectBusClient>> | undefined;
        try {
          const auth = resolveClientAuth(health);
          bus = await connectBusClient(undefined, { auth });
          const result = await bus.request(HostSubjects.app.focus, {});
          if (result.focused) {
            console.info('Makaio is now in the foreground.');
          } else {
            console.error('Failed to focus Makaio.');
            process.exitCode = 1;
          }
        } catch (error) {
          console.error(`Failed to focus Makaio: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        } finally {
          bus?.disconnect();
        }
        return;
      }

      if (launchApp()) {
        console.info('Makaio is starting.');
      }
    });
}

/**
 * Launch the Makaio desktop app as a detached child process.
 *
 * Resolves the platform-specific app path from `MAKAIO_APP`, then spawns a
 * detached process and unrefs it so the CLI process can exit immediately
 * without waiting for the app to start.
 * @returns `true` if a platform launch command was dispatched.
 */
function launchApp(): boolean {
  const platform = process.platform;

  const spawnDetached = (command: string, args: readonly string[]): boolean => {
    try {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
      child.once('error', (error) => {
        console.error(`Failed to launch Makaio: ${error.message}`);
        process.exitCode = 1;
      });
      child.unref();
      return true;
    } catch (error) {
      console.error(`Failed to launch Makaio: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return false;
    }
  };

  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    console.error(`Unsupported platform: ${platform}. Open Makaio.app manually.`);
    process.exitCode = 1;
    return false;
  }

  const appPath = resolveLaunchTarget(platform);
  if (appPath === null) {
    console.error('Cannot launch Makaio because no packaged app path is available.');
    console.error('Packaged launchers provide MAKAIO_APP automatically.');
    console.error('In development, start the desktop host first with: yarn dev:desktop');
    process.exitCode = 1;
    return false;
  }

  if (!existsSync(appPath)) {
    console.error(`Makaio is not installed at ${appPath}.`);
    console.error('Install Makaio or set MAKAIO_APP to the app install root or direct launch target.');
    console.error('In development, start with: yarn dev:desktop');
    process.exitCode = 1;
    return false;
  }

  return shouldUseMacOpen(platform, appPath) ? spawnDetached('open', [appPath]) : spawnDetached(appPath, []);
}

/**
 * Resolve the host-provided desktop launch target.
 *
 * `MAKAIO_APP` is the explicit host-policy seam: bundled host launchers set
 * it to their install root, while custom/rebranded hosts can set it directly to
 * an executable/app target and bypass Makaio-specific root normalization.
 * @param platform - Platform used to interpret install-root layout.
 * @returns The concrete launch target, or `null` when the host did not provide one.
 */
export function resolveLaunchTarget(platform: NodeJS.Platform): string | null {
  const configuredPath = process.env[MAKAIO_APP_ENV]?.trim();
  if (!configuredPath) return null;
  if (!isExistingDirectory(configuredPath)) return configuredPath;
  if (platform === 'linux') return path.posix.join(configuredPath, 'bin', 'makaio');
  if (platform === 'win32') return path.win32.join(configuredPath, 'Makaio.exe');
  return configuredPath;
}

/**
 * Return whether a configured launch path is an existing directory.
 * @param candidate - Host-provided path to inspect.
 * @returns `true` only when the path exists and stat reports a directory.
 */
function isExistingDirectory(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return whether a target should be launched through macOS LaunchServices.
 *
 * `open` is correct for `.app` bundles, but direct Mach-O executable targets
 * must be spawned directly so the documented `MAKAIO_APP` contract works.
 * @param platform - Runtime platform.
 * @param candidate - Resolved launch target.
 * @returns `true` when the target is a macOS application bundle.
 */
export function shouldUseMacOpen(platform: NodeJS.Platform, candidate: string): boolean {
  return platform === 'darwin' && candidate.endsWith('.app') && isExistingDirectory(candidate);
}
