/**
 * Bun host entry for the signal-handling E2E tests.
 *
 * Composes a Bun host exactly the way the product Bun apps (server, relay,
 * GitHub App) do: `Bun.serve` with the Bun-native bus transport, the runtime
 * booted under the lifecycle handle, and the signal handling installed through
 * `installBunHostShutdown` before the boot starts. The runtime carries the
 * fixture extensions of `signal-fixtures.ts`.
 *
 * Do NOT import from the application code path — this file is only ever
 * spawned as a child process, on Bun.
 */
/// <reference types="bun-types" />
import type { WebSocketHandler } from 'bun';
import { Hono } from 'hono';
import {
  BunBusServerTransportProvider,
  bootMakaioRuntime,
  bootUnderShutdown,
  createBunRouteGraphFetch,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
  createRuntimeLifecycle,
  installBunHostShutdown,
  type BunServer,
} from '@makaio/runtime-bun';
import { createSignalFixtureDiscovery, holdBootIfRequested } from './signal-fixtures.js';

const transport = new BunBusServerTransportProvider({ loopbackName: 'bun' });
const routeGraph = createHonoRouteGraph(new Hono());
const routeGraphBuilder = createHttpRouteGraphBuilder(routeGraph);
const bunServer = Bun.serve({
  fetch: createBunRouteGraphFetch(routeGraph),
  websocket: transport.createWebSocketHandler() as WebSocketHandler<undefined>,
  port: 0,
  hostname: '127.0.0.1',
}) as BunServer;
console.info(`[bun-host] Listening on http://127.0.0.1:${bunServer.port}`);

holdBootIfRequested();

const lifecycle = createRuntimeLifecycle();
const shutdown = installBunHostShutdown({ label: 'bun-host', lifecycle, bunServer });

const runtime = await bootUnderShutdown(lifecycle, shutdown, (hooks) =>
  bootMakaioRuntime({
    transport,
    bunServer,
    routeGraphBuilder,
    discovery: createSignalFixtureDiscovery(),
    hostCapabilities: ['bun'],
    surface: 'headless',
    enablePackageManager: false,
    ...hooks,
  }),
);
if (runtime === undefined) process.exit();

routeGraph.markReady();
process.stdout.write(`MAKAIO_PORT=${runtime.port}\n`);
