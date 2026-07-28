/**
 * Spawn a real minimal-config Electrobun process for E2E testing.
 *
 * The source-dev path lets Electrobun build the main process from
 * `src/main/index.ts`, matching the local desktop dev workflow while keeping
 * CI focused on the framework shell instead of loading every product extension.
 * @packageDocumentation
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { spawnAndDiscoverPort, type SpawnedProcess } from '../../shared/spawn-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root of the framework distribution containing this E2E harness. */
const FRAMEWORK_ROOT = path.resolve(__dirname, '../../..');

/** Absolute path to the Electrobun desktop package root. */
const ELECTROBUN_ROOT = path.join(FRAMEWORK_ROOT, 'apps/electrobun');

/** Package-manager workspace root that owns installed executable links. */
const WORKSPACE_ROOT = resolveWorkspaceRoot(ELECTROBUN_ROOT);

/** Path to the Electrobun executable installed by the root workspace. */
const ELECTROBUN_BIN = path.join(
  WORKSPACE_ROOT,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electrobun.cmd' : 'electrobun',
);

/** Options for {@link startElectrobun}. */
export interface StartElectrobunOptions {
  /** Additional environment variables. Merged on top of minimal defaults. */
  env?: Record<string, string>;
  /** Milliseconds to wait for port announcement. Defaults to 60 000. */
  timeoutMs?: number;
}

/** Handle to a spawned Electrobun process. */
export type ElectrobunProcess = SpawnedProcess;

/**
 * Spawn the real Electrobun composition root and wait for port announcement.
 * @param options - Spawn configuration.
 * @returns Handle to the spawned process with the discovered port.
 */
export async function startElectrobun(options?: StartElectrobunOptions): Promise<ElectrobunProcess> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(process.platform === 'linux' ? { DISPLAY: process.env['DISPLAY'] ?? ':0' } : {}),
    ...options?.env,
    MAKAIO_ELECTROBUN_SOURCE_DEV: '1',
    MAKAIO_INITIAL_WINDOW: 'framework-shell:main',
    NODE_ENV: 'development',
  };

  return spawnAndDiscoverPort({
    cmd: ELECTROBUN_BIN,
    args: ['dev'],
    spawnOptions: { cwd: ELECTROBUN_ROOT, env },
    timeoutMs,
    label: 'startElectrobun',
  });
}
