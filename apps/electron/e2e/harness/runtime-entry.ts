/**
 * Headless runtime entry point for E2E testing.
 *
 * Boots the full Makaio runtime (same {@link bootMakaioRuntime} call as the
 * Electron composition root) without any Electron APIs. Announces
 * `MAKAIO_PORT=<n>` on stdout for test harness port discovery.
 *
 * Usage: `tsx framework/apps/electron/e2e/harness/runtime-entry.ts`
 *
 * Environment variables:
 * - `MAKAIO_PORT` — TCP port to bind (default: `0` = OS-assigned)
 * - `MAKAIO_DATABASE_PATH` — path to the SQLite database (temp DB for E2E)
 */
import type { Server as HttpServer } from 'node:http';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import {
  waitForServerListening,
  bootMakaioRuntime,
  type MakaioRuntime,
  ExplicitDescriptorDiscovery,
  createHonoRouteGraph,
} from '@makaio/runtime-node';

const port = Number(process.env['MAKAIO_PORT']) || 0;

const honoApp = new Hono();
const routeGraph = createHonoRouteGraph(honoApp, { health: () => 'ok' });

const httpServer = createAdaptorServer({ fetch: routeGraph.fetch }) as HttpServer;
httpServer.listen(port, '127.0.0.1');
await waitForServerListening(httpServer, port);

let runtime: MakaioRuntime;
try {
  runtime = await bootMakaioRuntime({
    httpServer,
    surface: 'interactive',
    hostCapabilities: ['node'],
    // Skip filesystem scanning in E2E — the workspace node_modules glob is
    // expensive and can push boot past Playwright's webServer timeout in CI.
    discovery: new ExplicitDescriptorDiscovery([]),
    onTransportReady({ port: readyPort }) {
      // Announce port — test harness reads this from stdout.
      // Fires after the bus WebSocket handler is attached, so the port
      // is actually connectable.
      process.stdout.write(`MAKAIO_PORT=${readyPort}\n`);
    },
  });
  routeGraph.markReady();
} catch (err) {
  console.error('[electron-e2e] Boot failed:', err);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.exit(1);
}

// Graceful shutdown on signal.
let shuttingDown = false;

/**
 * Shut down the runtime and HTTP server, then exit.
 */
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.shutdown();
  } catch (err) {
    console.error('[electron-e2e] Shutdown error:', err);
  }
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.exit(0);
};

process.once(
  'SIGTERM',
  () =>
    void shutdown().catch((err) => {
      console.error('[electron-e2e] Unhandled shutdown error:', err);
      process.exit(1);
    }),
);
process.once(
  'SIGINT',
  () =>
    void shutdown().catch((err) => {
      console.error('[electron-e2e] Unhandled shutdown error:', err);
      process.exit(1);
    }),
);
