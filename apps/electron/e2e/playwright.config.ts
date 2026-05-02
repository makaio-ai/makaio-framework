import fs from 'node:fs';

import { defineConfig, devices } from '@playwright/test';
import getPort from 'get-port';

import { E2E_DB_PATH, E2E_PORT_FILE } from './harness/db-path.js';

/** Key used to store the runtime port in the port file. */
const RUNTIME_KEY = 'RUNTIME';

/** Key used to store the renderer port in the port file. */
const RENDERER_KEY = 'RENDERER';

/**
 * Resolved ports shared between the Playwright coordinator and worker
 * processes for a single e2e run.
 */
interface E2EPorts {
  /** TCP port for the headless Makaio runtime (HTTP + WebSocket bus). */
  runtime: number;
  /** TCP port for the Vite renderer dev server. */
  renderer: number;
}

/**
 * Validate a numeric TCP port.
 * @param port - Candidate port number.
 * @returns True when the port is an integer in the TCP user-port range.
 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

/**
 * Parse the shared port file into runtime and renderer ports.
 *
 * The file format is:
 * ```
 * RUNTIME=<n>
 * RENDERER=<n>
 * ```
 * @returns Parsed ports when both are valid, otherwise null.
 */
function readCachedPorts(): E2EPorts | null {
  try {
    const lines = fs.readFileSync(E2E_PORT_FILE, 'utf8').trim().split('\n');
    const entries = Object.fromEntries(
      lines.flatMap((line) => {
        const idx = line.indexOf('=');
        // Skip malformed lines so corrupted port files fall back to fresh ports.
        if (idx <= 0) return [];
        return [[line.slice(0, idx), line.slice(idx + 1)] as [string, string]];
      }),
    );
    const runtime = Number(entries[RUNTIME_KEY]);
    const renderer = Number(entries[RENDERER_KEY]);
    if (isValidPort(runtime) && isValidPort(renderer) && runtime !== renderer) {
      return { runtime, renderer };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically publish runtime and renderer ports to the shared port file.
 *
 * Playwright can evaluate this config in more than one process. Only the
 * first process may create the cache file; later processes must reuse it so
 * webServer URLs and worker baseURL cannot drift within the same run.
 * @param ports - The ports to persist.
 * @returns The cached ports that should be used by this process.
 */
function publishPorts(ports: E2EPorts): E2EPorts {
  try {
    fs.writeFileSync(E2E_PORT_FILE, `${RUNTIME_KEY}=${ports.runtime}\n${RENDERER_KEY}=${ports.renderer}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return ports;
  } catch (error: unknown) {
    const raced = readCachedPorts();
    if (raced !== null) {
      return raced;
    }
    throw error;
  }
}

/**
 * Resolve ports for the current e2e run.
 *
 * The top-level `yarn test:e2e:electron-pw` wrapper assigns a unique cache file
 * per run, so every invocation chooses free ports once and all worker
 * processes reuse those cached values for a stable `baseURL`.
 * @returns Ports shared by all Playwright processes for this run.
 */
async function resolveE2EPorts(): Promise<E2EPorts> {
  const cached = readCachedPorts();
  if (cached !== null) {
    return cached;
  }

  const runtime = await getPort({ host: '127.0.0.1' });
  const renderer = await getPort({ host: '127.0.0.1', exclude: [runtime] });
  return publishPorts({ runtime, renderer });
}

const ports = await resolveE2EPorts();
// Use 127.0.0.1 consistently (not localhost) to avoid IPv6 mismatches
// when localhost resolves to ::1 but the server binds IPv4.
const RENDERER_URL = `http://127.0.0.1:${ports.renderer}`;

/**
 * Playwright configuration for Electron renderer e2e tests.
 *
 * Starts two servers sequentially:
 * 1. Headless Makaio runtime (HTTP + WebSocket bus) — waited on via `/health`.
 * 2. Vite renderer dev server — waited on via the renderer URL.
 *
 * Uses unique ports per run so concurrent invocations stay isolated. The port
 * file written here is cleaned up by the global teardown.
 * @example
 * ```bash
 * yarn test:e2e:electron-pw           # Run all electron e2e tests
 * yarn test:e2e:electron-pw --headed  # Run with visible browser
 * yarn test:e2e:electron-pw:ui        # Run with Playwright UI
 * ```
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.test.ts',
  // Single-worker serialized execution keeps dev-server boot and bus handshake
  // deterministic and avoids Vite cold-start reload races on first navigation.
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  // Load-bearing: one worker avoids Vite cold-start reload races while the
  // shared port cache keeps coordinator and worker processes on the same URLs.
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  timeout: 30_000,
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL: RENDERER_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // DB cleanup runs as a prefix command (clean-db.ts) before the runtime boots,
  // not in globalSetup, because Playwright launches webServers BEFORE
  // globalSetup. Deleting the DB in globalSetup would destroy the file the
  // runtime just created, causing SQLITE_READONLY_DBMOVED.
  //
  // Note: Playwright resolves webServer.command from the config file's
  // directory (e2e/), so ./harness/clean-db.ts correctly resolves to the
  // harness subdirectory even when the test command runs from repo root.
  webServer: [
    {
      command: `node --import tsx ./harness/clean-db.ts && node --import tsx ./harness/runtime-entry.ts`,
      url: `http://127.0.0.1:${ports.runtime}/health`,
      // Never reuse — an existing runtime won't have MAKAIO_DATABASE_PATH set,
      // so tests would silently run against the user's real database.
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        MAKAIO_PORT: String(ports.runtime),
        MAKAIO_DATABASE_PATH: E2E_DB_PATH,
      },
    },
    {
      command: `yarn workspace @makaio/electron dev:renderer --host 127.0.0.1 --strictPort --port ${ports.renderer}`,
      url: RENDERER_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        MAKAIO_BUS_URL: `ws://127.0.0.1:${ports.runtime}/bus`,
        VITE_DISABLE_BUS_SERVER: 'true',
      },
    },
  ],
});
