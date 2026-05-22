/**
 * Spawn a real descriptor-backed Electron process for E2E testing.
 *
 * Unlike the headless `runtime-entry.ts` harness (which skips Electron APIs),
 * this spawns the actual `electron` binary through the framework desktop
 * composition root while selecting the fully loaded Makaio Dev config. It
 * exercises the full desktop boot path: platform migrations, BrowserWindow,
 * tray, bus server, runtime services, and descriptor-owned product extensions.
 *
 * Port discovery: the Electron main process writes `MAKAIO_PORT=<n>` to
 * stdout from the `onTransportReady` callback once the bus WebSocket handler
 * is attached. This spawner reads that line to discover the bound port.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAndDiscoverPort, type SpawnedProcess } from '../../shared/spawn-helpers.js';

const esmRequire = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root of the framework checkout — two levels up from e2e/desktop/. */
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Absolute path to the Electron desktop composition root. */
const ELECTRON_ENTRY = path.resolve(REPO_ROOT, 'apps/electron/src/main/main.ts');

/**
 * Resolve the path to the `electron` binary installed in node_modules.
 *
 * The `electron` npm package exports the absolute path to the binary as its
 * default export. Using `createRequire` avoids ESM import issues with the
 * non-standard export.
 * @returns Absolute path to the electron executable.
 */
function resolveElectronBinary(): string {
  return esmRequire('electron') as string;
}

/** Options for {@link startElectron}. */
export interface StartElectronOptions {
  /** Additional environment variables. Merged on top of minimal defaults. */
  env?: Record<string, string>;
  /** Milliseconds to wait for port announcement. Defaults to 60 000. */
  timeoutMs?: number;
}

/**
 * Handle to a spawned Electron process.
 *
 * Type alias for {@link SpawnedProcess} — callers may use either name.
 */
export type ElectronProcess = SpawnedProcess;

/**
 * Spawn the real Electron composition root and wait for port announcement.
 *
 * Waits for `MAKAIO_PORT=<n>` on stdout (emitted by the main process's
 * `onTransportReady` callback once the bus WebSocket handler is attached).
 * @param options - Spawn configuration.
 * @returns Handle to the spawned process with the discovered port.
 */
export function startElectron(options?: StartElectronOptions): Promise<ElectronProcess> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const electronBin = resolveElectronBinary();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(process.platform === 'linux' ? { DISPLAY: process.env['DISPLAY'] ?? ':0' } : {}),
    NODE_OPTIONS: [process.env['NODE_OPTIONS'], '--import tsx'].filter(Boolean).join(' '),
    ...options?.env,
    // Fully loaded Makaio Dev config invariants — must come after the options
    // spread so callers cannot accidentally turn this into a minimal runtime.
    MAKAIO_CONFIG_FILE: path.join(REPO_ROOT, 'makaio.config.all.ts'),
    // Skip session restore — open a deterministic Makaio Dev window.
    MAKAIO_INITIAL_WINDOW: 'makaio-dev.project-overview:main',
  };

  // Parse optional extra Chromium flags injected by CI (e.g. --no-sandbox on Linux).
  // Simple whitespace split — does not handle quoted arguments.
  const extraArgs = (env['ELECTRON_EXTRA_LAUNCH_ARGS'] ?? '').split(/\s+/).filter(Boolean);

  return spawnAndDiscoverPort({
    cmd: electronBin,
    args: [...extraArgs, ELECTRON_ENTRY],
    spawnOptions: { cwd: REPO_ROOT, env },
    timeoutMs,
    label: 'startElectron',
  });
}
