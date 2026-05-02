/**
 * Vite plugin for bus server integration.
 *
 * This plugin starts the full Makaio runtime alongside the Vite dev server,
 * allowing the browser to connect to backend services during development.
 *
 * ## Lifecycle
 * - {@link bootMakaioRuntime} attaches to Vite's HTTP server once it starts
 *   listening, sharing the same port via a raw `/bus` WebSocket upgrade
 *   handler on the underlying Node HTTP server.
 * - The full Node runtime (transport, storage, services, adapters, plugins)
 *   initializes in the background so Vite's HTTP server is not blocked. Bus
 *   handlers become available progressively as each service starts.
 * - Stops when Vite closes (on build completion or process exit).
 *
 * ## Features
 * - Path-gated WebSocket bus server on Vite's HTTP port
 * - HMAC authentication with configurable secret
 * - Non-blocking runtime initialization
 * - Clean shutdown with 10-second timeout guard
 * - Debug logging for developer experience
 */

import type { Plugin } from 'vite';
import type { Server as HttpServer } from 'node:http';
import { MakaioBus } from '@makaio/bus-core';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import { ExtensionSubjects } from '@makaio/kernel';
import {
  bootMakaioRuntime,
  normalizeNodeHostCapabilities,
  type BootMakaioRuntimeOptions,
  type MakaioRuntime,
} from '@makaio/runtime-node';

/**
 * Configuration options for the bus server plugin.
 */
export interface ViteBusServerPluginOptions {
  /**
   * Shared secret for HMAC authentication.
   *
   * Defaults to no authentication for development.
   * IMPORTANT: Use a strong secret in production.
   */
  secret?: string;

  /**
   * Enable debug logging.
   *
   * Defaults to false.
   */
  debug?: boolean;

  /**
   * Host-level runtime options merged into the {@link bootMakaioRuntime} call.
   *
   * Use this to supply custom discovery strategies, host capabilities, or an
   * explicit framework version.
   *
   * Only the host-configurable subset of {@link BootMakaioRuntimeOptions} is
   * exposed here. Transport, auth, and surface are owned by the plugin.
   */
  runtimeOptions?: Pick<BootMakaioRuntimeOptions, 'discovery' | 'frameworkVersion' | 'hostCapabilities'>;
}

/**
 * Build the runtime boot options owned by the Vite plugin.
 * @param options - HTTP server, auth, and host runtime options.
 * @returns Complete options object passed to {@link bootMakaioRuntime}.
 */
export function createViteRuntimeBootOptions(options: {
  readonly httpServer: HttpServer;
  readonly auth?: HmacAuth;
  readonly runtimeOptions?: ViteBusServerPluginOptions['runtimeOptions'];
}): BootMakaioRuntimeOptions {
  const { discovery, frameworkVersion, hostCapabilities } = options.runtimeOptions ?? {};

  return {
    ...(discovery !== undefined ? { discovery } : {}),
    ...(frameworkVersion !== undefined ? { frameworkVersion } : {}),
    httpServer: options.httpServer,
    auth: options.auth,
    loopbackName: 'vite',
    surface: 'interactive',
    hostCapabilities: normalizeNodeHostCapabilities(hostCapabilities),
  };
}

/**
 * Start the Makaio runtime in the background without blocking Vite startup.
 *
 * Delegates all transport, storage, identity, service, adapter, and plugin
 * wiring to {@link bootMakaioRuntime}. If startup succeeds while
 * `shuttingDown` is already true the runtime is shut down immediately to
 * avoid a resource leak.
 * @param httpServer - Vite's HTTP server, already listening.
 * @param auth - Pre-built HMAC auth strategy, or `undefined` for dev mode.
 * @param shuttingDown - Accessor that returns whether the plugin is shutting down.
 * @param debug - Enable debug logging.
 * @param runtimeOptions - Host-configurable runtime options forwarded to `bootMakaioRuntime`.
 * @returns Promise that resolves with the runtime handle, or `null` on failure.
 */
function startBackgroundRuntime(
  httpServer: HttpServer,
  auth: HmacAuth | undefined,
  shuttingDown: () => boolean,
  debug: boolean,
  runtimeOptions: ViteBusServerPluginOptions['runtimeOptions'],
): Promise<MakaioRuntime | null> {
  return (async () => {
    try {
      if (debug) {
        console.info('[vite-bus-server] Initializing Makaio runtime...');
      }
      const runtime = await bootMakaioRuntime(
        createViteRuntimeBootOptions({
          httpServer,
          auth,
          runtimeOptions,
        }),
      );
      if (shuttingDown()) {
        await runtime.shutdown();
        return null;
      }
      if (debug) {
        console.info('[vite-bus-server] Runtime ready on port %d', runtime.port);
      }
      return runtime;
    } catch (error) {
      console.error('[vite-bus-server] Failed to initialize runtime:', error);
      return null;
    }
  })();
}

/**
 * Create a Vite plugin that starts the full Makaio runtime.
 *
 * The plugin integrates with Vite's lifecycle to start and stop the runtime
 * automatically during development. All transport, storage, services, adapters,
 * and plugins are managed by {@link bootMakaioRuntime} — the plugin only owns
 * the HTTP server reference and the auth strategy.
 *
 * The runtime initializes after Vite's HTTP server binds its port. Handlers
 * register on the global MakaioBus progressively and become routable as each
 * service starts.
 * @param options - Plugin configuration options.
 * @returns Vite plugin instance.
 * @example
 * ```typescript
 * // vite.config.ts
 * import { ViteBusServerPlugin } from '@makaio/bus-server-vite';
 *
 * export default defineConfig({
 *   extensions: [
 *     react(),
 *     ViteBusServerPlugin({
 *       secret: process.env.BUS_SECRET,
 *       debug: true,
 *     }),
 *   ],
 * });
 * ```
 */
export function ViteBusServerPlugin(options: ViteBusServerPluginOptions = {}): Plugin {
  if (options.secret !== undefined && options.secret.trim() === '') {
    throw new Error(
      '[vite-bus-server] options.secret is set but empty; pass a non-empty secret or omit it for dev mode',
    );
  }

  const debug = options.debug ?? false;

  let runtimeResult: Promise<MakaioRuntime | null> | null = null;
  let shuttingDown = false;
  let extensionEventCleanup: (() => void) | undefined;

  return {
    name: 'vite-bus-server',

    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const httpServer = server.httpServer;
        if (!httpServer) {
          console.error('[vite-bus-server] HTTP server is not available');
          return;
        }

        if (debug) {
          extensionEventCleanup = MakaioBus.on(ExtensionSubjects.stateChanged, ({ payload }) => {
            const status = payload.to === 'failed' ? '✗' : payload.to === 'active' ? '✓' : '…';
            console.info(`[ext] ${status} ${payload.displayName}: ${payload.from} → ${payload.to}`);
            if (payload.error) {
              console.warn(`  Error: ${payload.error}`);
            }
          });
        }

        runtimeResult = startBackgroundRuntime(
          // Vite's httpServer is typed as `http.Server | Http2SecureServer`.
          // In dev mode Vite always binds an HTTP/1.1 server; the cast is safe.
          httpServer as HttpServer,
          options.secret ? new HmacAuth({ secret: options.secret }) : undefined,
          () => shuttingDown,
          debug,
          options.runtimeOptions,
        );
      });
    },

    async closeBundle() {
      shuttingDown = true;
      extensionEventCleanup?.();

      if (runtimeResult) {
        // Sentinel distinguishes timeout from a genuine null runtime result.
        const TIMEOUT = Symbol('timeout');
        const result = await Promise.race([
          runtimeResult,
          new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), 10_000)),
        ]).catch((error: unknown) => {
          console.warn('[vite-bus-server] Runtime init did not complete before shutdown:', error);
          return null;
        });

        if (result === TIMEOUT) {
          console.warn('[vite-bus-server] Runtime init timed out after 10 s — skipping graceful shutdown');
        } else if (result) {
          try {
            await result.shutdown();
          } catch (error) {
            console.warn('[vite-bus-server] Error during runtime shutdown:', error);
          }
        }
      }
    },
  };
}
