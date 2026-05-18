/**
 * Spawn a real Electrobun process for E2E testing.
 *
 * This harness intentionally omits host runtime config. It exercises the
 * Electrobun shell as a source checkout should boot: default packages,
 * fallback window, and no host descriptor discovery.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAndDiscoverPort, type SpawnedProcess } from '../shared/spawn-helpers.js';

/** Options for {@link startElectrobun}. */
export interface StartElectrobunOptions {
  /** Additional environment variables. Merged on top of minimal defaults. */
  env?: Record<string, string>;
  /** Milliseconds to wait for port announcement. Defaults to 60 000. */
  timeoutMs?: number;
}

/** Handle to a spawned Electrobun process. */
export type ElectrobunProcess = SpawnedProcess;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root for this source checkout. */
const REPO_ROOT = path.resolve(__dirname, '../..');

/** Process cwd that owns the installed Electrobun dependency for this checkout. */
const REPO_NODE_MODULES = path.resolve(REPO_ROOT, 'node_modules');
const PARENT_NODE_MODULES = path.resolve(REPO_ROOT, '..', 'node_modules');
const ELECTROBUN_BIN_NAME = process.platform === 'win32' ? 'electrobun.cmd' : 'electrobun';
const SPAWN_CWD = existsSync(path.resolve(REPO_NODE_MODULES, '.bin', ELECTROBUN_BIN_NAME))
  ? REPO_ROOT
  : path.resolve(REPO_ROOT, '..');

/** Absolute path to the Electrobun desktop package root. */
const ELECTROBUN_ROOT = path.resolve(REPO_ROOT, 'apps/electrobun');

/** Parent environment keys intentionally forwarded to the child Electrobun process. */
const BASE_ENV_KEYS = [
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

/**
 * Resolve the path to the `electrobun` binary installed in node_modules.
 * @returns Absolute path to the Electrobun executable.
 */
function resolveElectrobunBinary(): string {
  const binaryPath = path.resolve(SPAWN_CWD, 'node_modules/.bin', ELECTROBUN_BIN_NAME);
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Failed to locate electrobun binary. Checked:\n- ${path.resolve(
        REPO_NODE_MODULES,
        '.bin',
        ELECTROBUN_BIN_NAME,
      )}\n- ${path.resolve(PARENT_NODE_MODULES, '.bin', ELECTROBUN_BIN_NAME)}`,
    );
  }
  return binaryPath;
}

/**
 * Build a minimal child-process environment for Electrobun E2E.
 * @param overrides - Caller-provided environment overrides.
 * @returns Sanitized environment without leaked host policy.
 */
function createElectrobunEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (process.platform === 'linux') {
    env['DISPLAY'] = process.env['DISPLAY'] ?? ':0';
  }

  env['MAKAIO_CREDENTIAL_STORAGE'] = process.env['MAKAIO_CREDENTIAL_STORAGE'] ?? 'memory';
  env['MAKAIO_ELECTROBUN_SOURCE_DEV'] = '1';
  env['NODE_ENV'] = 'development';

  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value;
  }

  for (const key of Object.keys(env)) {
    if ((key.startsWith('MAKAIO_HOST_') || key === 'MAKAIO_INITIAL_WINDOW') && !(key in overrides)) {
      delete env[key];
    }
  }

  return env;
}

/**
 * Spawn the real Electrobun composition root without host policy.
 * @param options - Spawn configuration.
 * @returns Handle to the spawned process with the discovered port.
 */
export function startElectrobun(options?: StartElectrobunOptions): Promise<ElectrobunProcess> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const electrobunBin = resolveElectrobunBinary();
  const env = createElectrobunEnv(options?.env);

  return spawnAndDiscoverPort({
    cmd: electrobunBin,
    args: ['dev'],
    spawnOptions: { cwd: ELECTROBUN_ROOT, env },
    timeoutMs,
    label: 'startElectrobun',
  });
}
