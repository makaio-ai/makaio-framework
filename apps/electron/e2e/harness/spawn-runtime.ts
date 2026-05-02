/**
 * Spawn the Electron headless runtime process for E2E testing.
 *
 * Reads `MAKAIO_PORT=<n>` from stdout to discover the OS-assigned port.
 * The runtime entry defaults to port 0 (OS-assigned) when `MAKAIO_PORT` is
 * unset, so no explicit env var is required for CI safety.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAndDiscoverPort, type SpawnedProcess } from '../../../../e2e/shared/spawn-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root used as the spawn cwd for this framework E2E harness. */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/** Absolute path to the headless runtime standalone entry. */
const RUNTIME_ENTRY = path.resolve(__dirname, './runtime-entry.ts');

/** Default boot timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Options for spawning a headless Electron runtime process.
 */
export interface SpawnRuntimeOptions {
  /**
   * Additional environment variables to pass to the child process.
   * Merged on top of the minimal defaults (PATH, HOME).
   */
  env?: Record<string, string>;
  /**
   * Milliseconds to wait for the process to write `MAKAIO_PORT=<n>` to stdout.
   * Defaults to 60 000.
   */
  timeoutMs?: number;
}

/**
 * A handle to a spawned headless runtime process.
 *
 * Type alias for {@link SpawnedProcess} — callers may use either name.
 */
export type RuntimeProcess = SpawnedProcess;

/**
 * Spawn the headless runtime entry point via `tsx` and wait until it announces
 * its bound port via `MAKAIO_PORT=<n>` on stdout.
 * @param options - Spawn configuration (env overrides, timeout).
 * @returns A {@link RuntimeProcess} handle with the bound port and a kill function.
 */
export function startElectronRuntime(options?: SpawnRuntimeOptions): Promise<RuntimeProcess> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    ...options?.env,
  };

  // Note: spawn without shell:true works for tsx on macOS/Linux where the
  // binary is a proper executable. On Windows, npm .cmd shims would require
  // shell:true — not needed until we support Windows CI.
  return spawnAndDiscoverPort({
    cmd: 'tsx',
    args: [RUNTIME_ENTRY],
    spawnOptions: { cwd: REPO_ROOT, env },
    timeoutMs,
    label: 'startElectronRuntime',
  });
}
