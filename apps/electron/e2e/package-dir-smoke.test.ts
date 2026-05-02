/**
 * Smoke test for the packaged Electron directory artifact.
 *
 * Builds the unsigned `release/mac-arm64/Makaio.app`, verifies the packaged
 * CLI launcher resources, launches the app, and waits for the runtime and
 * first BrowserWindow navigation to complete.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import getPort from 'get-port';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_ROOT = path.resolve(__dirname, '..');
const PACKAGED_APP = path.join(APP_ROOT, 'release', 'mac-arm64', 'Makaio.app', 'Contents', 'MacOS', 'Makaio');
const PACKAGED_RESOURCES = path.join(APP_ROOT, 'release', 'mac-arm64', 'Makaio.app', 'Contents', 'Resources');

// Patterns that indicate a genuine startup failure (not handled/expected conditions).
// workspace-root resolution failures are expected in packaged apps and handled
// gracefully by resolveStaticModelRegistryPath — they are NOT fatal.
const FATAL_STARTUP_PATTERNS = [
  'Cannot find module',
  'No handler registered for request subject "storage:extensionConfig.list"',
  'invalid browser factory',
];
const DEFAULT_PACKAGE_TIMEOUT_MS = 120_000;

/**
 * Options for {@link runCommand}.
 */
interface RunCommandOptions {
  /** Executable to run. */
  command: string;
  /** Command arguments. */
  args: readonly string[];
  /** Environment overrides. */
  env: NodeJS.ProcessEnv;
  /** Process timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Spawn a process and resolve with combined stdout/stderr when it exits.
 * @param options - Command, arguments, environment, and timeout.
 * @returns Combined stdout and stderr output.
 */
function runCommand(options: RunCommandOptions): Promise<string> {
  const { command, args, env, timeoutMs } = options;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args as string[], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`[${command}] timed out after ${timeoutMs}ms\n${output}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`[${command}] exited with code ${String(code)}\n${output}`));
      }
    });
  });
}

/**
 * Resolve the package build timeout for the smoke test.
 * @returns Timeout in milliseconds.
 */
function resolvePackageTimeoutMs(): number {
  const raw = process.env['MAKAIO_PACKAGE_DIR_SMOKE_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_PACKAGE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PACKAGE_TIMEOUT_MS;
}

/**
 * Launch the packaged app and wait for runtime-ready and window-load logs.
 * @returns Captured app output through the first window load.
 */
async function launchPackagedApp(): Promise<string> {
  const port = await getPort();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'makaio-packaged-e2e-'));
  const dbPath = path.join(tempDir, 'makaio.db');

  return new Promise<string>((resolve, reject) => {
    const child = spawn(PACKAGED_APP, ['--no-sandbox'], {
      cwd: REPO_ROOT,
      env: { ...process.env, MAKAIO_PORT: String(port), MAKAIO_DATABASE_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      rmSync(tempDir, { recursive: true, force: true });
      if (error) {
        reject(error);
      } else {
        resolve(output);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`[packaged-electron] timed out waiting for runtime/window readiness\n${output}`));
    }, 60_000);

    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      const fatal = FATAL_STARTUP_PATTERNS.find((pattern) => output.includes(pattern));
      if (fatal) {
        finish(new Error(`[packaged-electron] fatal startup output matched "${fatal}"\n${output}`));
        return;
      }
      if (output.includes('[electron] Runtime ready') && output.includes('[WindowManager] Loaded URL:')) {
        finish();
      }
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) {
        finish(new Error(`[packaged-electron] exited with code ${String(code)} before readiness\n${output}`));
      }
    });
  });
}

describe('packaged Electron directory artifact', { timeout: 180_000 }, () => {
  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
    'packages, launches, and loads the first window',
    async () => {
      await runCommand({
        command: 'yarn',
        args: ['workspace', '@makaio/electron', 'package:dir'],
        env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        timeoutMs: resolvePackageTimeoutMs(),
      });

      expect(existsSync(PACKAGED_APP)).toBe(true);
      expect(existsSync(path.join(PACKAGED_RESOURCES, 'install-cli.sh'))).toBe(true);
      expect(existsSync(path.join(PACKAGED_RESOURCES, 'makaio-launcher.sh'))).toBe(true);

      const launchOutput = await launchPackagedApp();
      expect(launchOutput).toContain('[electron] Runtime ready');
      expect(launchOutput).toContain('[WindowManager] Loaded URL:');
      for (const pattern of FATAL_STARTUP_PATTERNS) {
        expect(launchOutput).not.toContain(pattern);
      }
    },
  );
});
