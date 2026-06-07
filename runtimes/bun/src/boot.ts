/**
 * Makaio runtime boot sequence — Bun platform entry point.
 *
 * Thin wrapper around the platform-agnostic {@link bootMakaioRuntimeCore}
 * from `@makaio/runtime-node`. Accepts a pre-constructed
 * {@link BunBusServerTransportProvider} and a Bun server handle, then
 * delegates all startup logic to the shared core.
 *
 * The composition root is responsible for the following steps before calling
 * {@link bootMakaioRuntime}:
 * 1. Create a {@link BunBusServerTransportProvider}.
 * 2. Call {@link BunBusServerTransportProvider.createWebSocketHandler} to
 *    obtain a native Bun WebSocket handler.
 * 3. Start the Bun server via `Bun.serve({ fetch, websocket, port })`,
 *    passing the handler from step 2.
 * 4. Call `bootMakaioRuntime({ transport, bunServer, ...options })`.
 *
 * This ordering ensures the WebSocket handler is registered with `Bun.serve`
 * before boot starts, and that the handler remains valid across Hono route
 * graph rebuilds (which create a fresh `new Hono()` but do not affect the
 * native Bun server or its WebSocket handler).
 * @example
 * ```typescript
 * import {
 *   BunBusServerTransportProvider,
 *   bootMakaioRuntime,
 *   createBunRouteGraphFetch,
 * } from '@makaio/runtime-bun';
 *
 * const transport = new BunBusServerTransportProvider({ auth });
 * const websocket = transport.createWebSocketHandler();
 * const bunServer = Bun.serve({ fetch: createBunRouteGraphFetch(routeGraph), websocket, port: 3000 });
 * const runtime = await bootMakaioRuntime({ transport, bunServer });
 * console.log(`Listening on port ${runtime.port}`);
 * ```
 */

import { bootMakaioRuntimeCore, type CoreBootOptions, type MakaioRuntime } from '@makaio/runtime-node';
import { BunBusServerTransportProvider } from './bus-server-transport.js';
import { type BunServer } from './http-server-utils.js';

/**
 * Options for {@link bootMakaioRuntime} (Bun platform).
 *
 * Extends the platform-agnostic {@link CoreBootOptions} with the Bun server
 * instance and the pre-constructed transport. The composition root creates the
 * transport and extracts the WebSocket handler before starting the Bun server,
 * then passes both here.
 */
export interface BunBootMakaioRuntimeOptions extends CoreBootOptions {
  /**
   * Bun server instance, already listening.
   *
   * Must be started with the WebSocket handler obtained from
   * {@link BunBusServerTransportProvider.createWebSocketHandler} so that the
   * bus transport can accept connections.
   */
  bunServer: BunServer;

  /**
   * Pre-constructed bus server transport provider.
   *
   * The composition root creates the transport, calls
   * {@link BunBusServerTransportProvider.createWebSocketHandler} to get the
   * native handler for `Bun.serve`, then passes the transport here.
   * This ensures the WebSocket handler is registered before boot begins.
   */
  transport: BunBusServerTransportProvider;
}

/**
 * Boot the full Makaio runtime against a pre-existing Bun server.
 *
 * Delegates all startup logic to the platform-agnostic
 * {@link bootMakaioRuntimeCore}. The caller owns the Bun server and transport
 * lifecycle. This function owns everything from step 1 (Config) through
 * step 12 (Ready) and returns a {@link MakaioRuntime} handle that the caller
 * uses to shut down.
 * @param options - Boot configuration including the pre-bound Bun server and
 *   pre-constructed transport provider.
 * @returns Runtime handle with `port`, `machineId`, and `shutdown()`.
 */
export async function bootMakaioRuntime(options: BunBootMakaioRuntimeOptions): Promise<MakaioRuntime> {
  const { port, hostname } = options.bunServer;
  const createMount = options.createMount ?? (await import('./create-static-mount.js')).defaultCreateMount;
  return bootMakaioRuntimeCore(options.transport, port, hostname, {
    ...options,
    createMount,
  });
}
