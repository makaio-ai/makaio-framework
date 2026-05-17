/**
 * Spawn the CLI serve process for E2E testing.
 *
 * Reads `MAKAIO_PORT=<n>` from stdout to discover the OS-assigned port.
 * Passes `--port 0` so the OS picks a free port (CI-safe).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { spawnAndDiscoverPort, type SpawnedProcess } from '../../../../e2e/shared/spawn-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root used as the spawn cwd for this framework E2E harness. */
const REPO_ROOT = resolveWorkspaceRoot(path.resolve(__dirname, '../..'));

/** Absolute path to the CLI serve standalone entry. */
const CLI_ENTRY = path.resolve(__dirname, './cli-serve-entry.ts');

/** Default boot timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Options for spawning a CLI serve process.
 */
export interface SpawnServeOptions {
  /**
   * Absolute path to the spawned entry module.
   * Defaults to the standard CLI serve harness entry.
   */
  entryPath?: string;
  /**
   * Additional environment variables to pass to the child process.
   * Merged on top of the minimal defaults (PATH, HOME).
   */
  env?: Record<string, string>;
  /**
   * Milliseconds to wait for the process to write `MAKAIO_PORT=<n>` to stdout.
   * Defaults to 30 000.
   */
  timeoutMs?: number;
}

/**
 * A handle to a spawned CLI serve process.
 *
 * Type alias for {@link SpawnedProcess} — callers may use either name.
 */
export type ServeProcess = SpawnedProcess;

/**
 * Spawn the CLI serve entry point via `tsx` and wait until it announces its
 * bound port via `MAKAIO_PORT=<n>` on stdout.
 * @param options - Spawn configuration (env overrides, timeout).
 * @returns A {@link ServeProcess} handle with the bound port and a kill function.
 */
export function startCliServe(options?: SpawnServeOptions): Promise<ServeProcess> {
  return startCliServeInternal(options);
}

/**
 * Validate the spawned entry module before creating the child process.
 * @param entryPath - Absolute entry module path.
 */
async function assertEntryFile(entryPath: string): Promise<void> {
  if (!path.isAbsolute(entryPath)) {
    throw new Error(`SpawnServeOptions.entryPath must be an absolute path: ${entryPath}`);
  }

  try {
    const stats = await fs.stat(entryPath);
    if (stats.isFile()) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  throw new Error(`SpawnServeOptions.entryPath must exist and be a file: ${entryPath}`);
}

/**
 * Spawn the CLI serve process with an isolated temporary database.
 * @param options - Spawn configuration forwarded from the public helper.
 * @returns Serve-process handle that also cleans up the temp database on exit.
 */
async function startCliServeInternal(options?: SpawnServeOptions): Promise<ServeProcess> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const entryPath = options?.entryPath ?? CLI_ENTRY;
  await assertEntryFile(entryPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-cli-e2e-'));
  const dbPath = path.join(tempDir, 'makaio.db');
  const homeDir =
    options?.env?.HOME ?? options?.env?.USERPROFILE ?? process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: homeDir,
    USERPROFILE: options?.env?.USERPROFILE ?? process.env['USERPROFILE'] ?? homeDir,
    MAKAIO_DATABASE_PATH: dbPath,
    ...options?.env,
  };

  let cleaned = false;
  const cleanupTempDir = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  try {
    const proc = await spawnAndDiscoverPort({
      cmd: 'tsx',
      args: [entryPath],
      spawnOptions: { cwd: REPO_ROOT, env },
      timeoutMs,
      label: 'startCliServe',
    });

    return {
      ...proc,
      sendSignal: async (signal) => {
        try {
          return await proc.sendSignal(signal);
        } finally {
          await cleanupTempDir();
        }
      },
      kill: async () => {
        try {
          await proc.kill();
        } finally {
          await cleanupTempDir();
        }
      },
    };
  } catch (error) {
    await cleanupTempDir();
    throw error;
  }
}
