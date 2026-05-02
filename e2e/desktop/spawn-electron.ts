/**
 * Spawn a real framework-only Electron process for E2E testing.
 *
 * This harness intentionally omits host runtime config. It exercises the
 * framework Electron shell as a framework-only source checkout should boot:
 * framework packages only, framework fallback window, no host descriptor
 * discovery.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAndDiscoverPort, type SpawnedProcess } from '../shared/spawn-helpers.js';

const esmRequire = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root of the framework checkout used by the synced standalone distribution. */
const FRAMEWORK_ROOT = path.resolve(__dirname, '../..');

/** Process cwd that owns the installed Electron/tsx dependencies for this checkout. */
const SPAWN_CWD = existsSync(path.resolve(FRAMEWORK_ROOT, 'node_modules'))
  ? FRAMEWORK_ROOT
  : path.resolve(FRAMEWORK_ROOT, '..');

/** Absolute path to the Electron app entry point. */
const ELECTRON_ENTRY = path.resolve(FRAMEWORK_ROOT, 'apps/electron/src/main/main.ts');

/** Parent environment keys intentionally forwarded to the child Electron process. */
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
  'ELECTRON_EXTRA_LAUNCH_ARGS',
] as const;

/** Options for {@link startFrameworkElectron}. */
export interface StartFrameworkElectronOptions {
  /** Additional environment variables. Merged on top of minimal defaults. */
  env?: Record<string, string>;
  /** Milliseconds to wait for port announcement. Defaults to 60 000. */
  timeoutMs?: number;
}

/** Handle to a spawned framework Electron process. */
export type FrameworkElectronProcess = SpawnedProcess;

/**
 * Resolve the path to the `electron` binary installed in node_modules.
 * @returns Absolute path to the electron executable.
 */
function resolveElectronBinary(): string {
  return esmRequire('electron') as string;
}

/**
 * Build a minimal child-process environment for framework-only Electron E2E.
 * @param overrides - Caller-provided environment overrides.
 * @returns Sanitized environment without leaked host policy.
 */
function createFrameworkElectronEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
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

  env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], '--import tsx'].filter(Boolean).join(' ');

  // Default to memory-backed credential storage so the spawned Electron never
  // invokes the macOS `security` CLI. The test overrides HOME to a temp dir,
  // which makes the default keychain unreachable (macOS resolves it via HOME).
  env['MAKAIO_CREDENTIAL_STORAGE'] = process.env['MAKAIO_CREDENTIAL_STORAGE'] ?? 'memory';

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
 * Spawn the real Electron composition root without host policy.
 * @param options - Spawn configuration.
 * @returns Handle to the spawned process with the discovered port.
 */
export function startFrameworkElectron(options?: StartFrameworkElectronOptions): Promise<FrameworkElectronProcess> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const electronBin = resolveElectronBinary();
  const env = createFrameworkElectronEnv(options?.env);

  const extraArgs = (env['ELECTRON_EXTRA_LAUNCH_ARGS'] ?? '').split(/\s+/).filter(Boolean);

  return spawnAndDiscoverPort({
    cmd: electronBin,
    args: [...extraArgs, ELECTRON_ENTRY],
    spawnOptions: { cwd: SPAWN_CWD, env },
    timeoutMs,
    label: 'startFrameworkElectron',
  });
}
